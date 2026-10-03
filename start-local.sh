#!/usr/bin/env bash
# Headless recording launcher: local PostgreSQL + Redis + MinIO, migrations, API and Web dev servers.
# Writes api-url / web-url into the state directory and stops everything it started on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

STATE_DIR="${STATE_DIR:-$HOME/.cache/code10-16-b}"
LOG_DIR="$STATE_DIR/logs"
export TZ="${TZ:-Asia/Shanghai}"
export NODE_ENV=development
mkdir -p "$STATE_DIR" "$LOG_DIR"

log() { printf '[start-local] %s\n' "$*"; }
fail() { printf '[start-local] ERROR: %s\n' "$*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || fail "需要 Node.js 22+，当前为 $(node -v 2>/dev/null || echo unknown)"
for bin in initdb pg_ctl createdb psql redis-server redis-cli minio curl lsof; do
  command -v "$bin" >/dev/null 2>&1 || fail "缺少命令：$bin"
done

free_port() {
  node -e 'const net=require("net");const s=net.createServer();s.on("error",()=>process.exit(1));s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}
port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# The Web dev server proxies /api to a hard-coded http://localhost:3000, so the API must own 3000.
API_PORT=3000
for _ in $(seq 1 60); do port_in_use "$API_PORT" || break; sleep 0.5; done
port_in_use "$API_PORT" && fail "端口 3000 已被占用（Web 端 Vite 代理固定指向 3000）"

WEB_PORT="$(free_port)"
PG_PORT="$(free_port)"
REDIS_PORT="$(free_port)"
MINIO_PORT="$(free_port)"
MINIO_CONSOLE_PORT="$(free_port)"

PGDATA="$STATE_DIR/pgdata"
REDIS_DIR="$STATE_DIR/redis"
MINIO_DATA="$STATE_DIR/minio-data"
UPLOAD_DIR="$STATE_DIR/uploads"
mkdir -p "$REDIS_DIR" "$MINIO_DATA" "$UPLOAD_DIR"

API_PID=""
WEB_PID=""
MINIO_PID=""
PG_STARTED=0
REDIS_STARTED=0

kill_tree() {
  local pid="$1" child
  [ -n "$pid" ] || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill -TERM "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  trap - EXIT INT TERM
  kill_tree "$WEB_PID"
  kill_tree "$API_PID"
  if [ "$REDIS_STARTED" = 1 ]; then redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true; fi
  kill_tree "$MINIO_PID"
  if [ "$PG_STARTED" = 1 ]; then pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true; fi
  rm -f "$STATE_DIR/api-url" "$STATE_DIR/web-url"
  log "已停止本脚本启动的全部进程"
}
trap cleanup EXIT INT TERM

SECRETS_FILE="$STATE_DIR/secrets.env"
if [ ! -s "$SECRETS_FILE" ]; then
  {
    printf 'JWT_ACCESS_SECRET=%s\n' "$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    printf 'REFRESH_TOKEN_PEPPER=%s\n' "$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  } > "$SECRETS_FILE"
fi
# shellcheck disable=SC1090
set -a
source "$SECRETS_FILE"
set +a

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "初始化 PostgreSQL 数据目录"
  initdb -D "$PGDATA" -U postgres -A trust --encoding=UTF8 --locale=C >/dev/null
fi
log "启动 PostgreSQL（端口 $PG_PORT）"
pg_ctl -D "$PGDATA" -l "$LOG_DIR/postgres.log" \
  -o "-p $PG_PORT -k $STATE_DIR -h 127.0.0.1" -w start >/dev/null
PG_STARTED=1

if [ "${RESET_DB:-0}" = "1" ]; then
  log "重置演示数据库"
  dropdb --if-exists -h 127.0.0.1 -p "$PG_PORT" -U postgres practice >/dev/null 2>&1 || true
fi

if ! psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='practice'" | grep -q 1; then
  createdb -h 127.0.0.1 -p "$PG_PORT" -U postgres practice
fi

log "启动 Redis（端口 $REDIS_PORT）"
redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$REDIS_DIR" \
  --save "" --appendonly no --daemonize yes \
  --pidfile "$STATE_DIR/redis.pid" --logfile "$LOG_DIR/redis.log"
REDIS_STARTED=1

log "启动 MinIO（端口 $MINIO_PORT）"
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  nohup minio server "$MINIO_DATA" --address "127.0.0.1:$MINIO_PORT" \
  --console-address "127.0.0.1:$MINIO_CONSOLE_PORT" >"$LOG_DIR/minio.log" 2>&1 &
MINIO_PID=$!
for _ in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:$MINIO_PORT/minio/health/live" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "http://127.0.0.1:$MINIO_PORT/minio/health/live" >/dev/null 2>&1 || fail "MinIO 未能启动"

export DATABASE_URL="postgresql://postgres@127.0.0.1:$PG_PORT/practice?schema=public"
export REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
export S3_ENDPOINT="http://127.0.0.1:$MINIO_PORT"
export S3_PUBLIC_ENDPOINT="http://127.0.0.1:$MINIO_PORT"
export S3_REGION="us-east-1"
export S3_BUCKET="practice-audio"
export S3_ACCESS_KEY="minioadmin"
export S3_SECRET_KEY="minioadmin"
export S3_FORCE_PATH_STYLE="true"
export PUBLIC_API_ORIGIN="http://127.0.0.1:$API_PORT"
export WEB_ORIGIN="http://127.0.0.1:$WEB_PORT"
export UPLOAD_DIR
export METRICS_ENABLED="false"
export LOG_LEVEL="${LOG_LEVEL:-warn}"
export API_PORT

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  log "安装依赖"
  npm install --no-audit --no-fund >/dev/null
fi
case "$(uname -s)" in
  Darwin) PRISMA_ENGINE_GLOB="libquery_engine-darwin-*" ;;
  *) PRISMA_ENGINE_GLOB="libquery_engine-linux-*" ;;
esac
if ! ls node_modules/.prisma/client/$PRISMA_ENGINE_GLOB >/dev/null 2>&1; then
  log "生成当前平台的 Prisma Client"
  npm run db:generate >/dev/null
fi
log "构建共享 contracts 包"
npm run build -w @practice/contracts >/dev/null
log "应用数据库迁移"
npm run db:deploy 2>&1 | sed 's/^/[prisma] /'

log "确保对象存储 Bucket 存在"
S3_ENDPOINT="$S3_ENDPOINT" node --input-type=module -e '
import { S3Client, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
});
try {
  await client.send(new HeadBucketCommand({ Bucket: "practice-audio" }));
} catch {
  await client.send(new CreateBucketCommand({ Bucket: "practice-audio" }));
}
console.log("bucket practice-audio ready");
'

log "启动 API（端口 $API_PORT）"
npm run dev -w @practice/api >"$LOG_DIR/api.log" 2>&1 &
API_PID=$!

log "启动 Web（端口 $WEB_PORT）"
NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first" \
  npm run dev -w @practice/web -- --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!

API_READY=0
for _ in $(seq 1 240); do
  if curl -fsS "http://127.0.0.1:$API_PORT/health/ready" >/dev/null 2>&1; then API_READY=1; break; fi
  kill -0 "$API_PID" >/dev/null 2>&1 || { tail -n 30 "$LOG_DIR/api.log" >&2 || true; fail "API 进程提前退出"; }
  sleep 0.25
done
[ "$API_READY" = 1 ] || { tail -n 30 "$LOG_DIR/api.log" >&2 || true; fail "API 未在限定时间内就绪"; }

for _ in $(seq 1 160); do
  curl -fsS "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 || fail "Web 未能启动"

printf 'http://127.0.0.1:%s\n' "$API_PORT" > "$STATE_DIR/api-url"
printf 'http://127.0.0.1:%s\n' "$WEB_PORT" > "$STATE_DIR/web-url"
printf '%s\n' "$PG_PORT" > "$STATE_DIR/pg-port"
printf '%s\n' "$REDIS_PORT" > "$STATE_DIR/redis-port"
printf '%s\n' "$MINIO_PORT" > "$STATE_DIR/minio-port"

log "API: http://127.0.0.1:$API_PORT"
log "Web: http://127.0.0.1:$WEB_PORT"
log "就绪，等待录制结束"

wait
