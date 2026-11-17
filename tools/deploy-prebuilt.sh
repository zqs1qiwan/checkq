#!/bin/sh
# 低内存设备部署：直接替换运行中容器里的前端产物与服务端代码，**不在设备上构建镜像**
#
# 为什么需要它：树莓派 / 软路由这类设备跑 `docker build`（npm ci + vite build）会耗尽内存，
# 表现为设备反复重启、容器卡在 Removal In Progress。
# 本脚本配合「在开发机上先构建好 web/dist」使用：
#   1) 开发机：cd web && npm run build
#   2) 开发机：把 web/dist + server/src 打成 tar.gz，scp 到设备
#   3) 设备：sh deploy-prebuilt.sh /tmp/checkq-prebuilt.tgz
#
# 行为：备份旧容器 → 替换文件 → 重启 → 健康检查 → docker commit 成新镜像（保证下次重建不丢）
set -e

TARBALL="${1:-/tmp/checkq-prebuilt.tgz}"
CONTAINER="${CHECKQ_CONTAINER:-checkq}"
TAG="${CHECKQ_TAG:-checkq:latest}"
WORK="$(mktemp -d /tmp/checkq-deploy.XXXXXX)"

if [ ! -f "$TARBALL" ]; then
  echo "找不到 $TARBALL" >&2
  exit 1
fi

echo "==> 解包 $TARBALL"
tar -xzf "$TARBALL" -C "$WORK"

# 替换前先备份当前镜像（健康检查失败时至少有一个可回退的镜像）
echo "==> 备份当前镜像为 ${TAG}.bak"
docker commit "$CONTAINER" "${TAG}.bak" >/dev/null || { echo "备份镜像失败，已中止（未改动容器）" >&2; exit 1; }

# 设备刚重启时容器可能还没起来（docker 会按 restart 策略拉起，但有延迟）
if ! docker ps --filter "name=^${CONTAINER}$" --filter status=running -q | grep -q .; then
  echo "==> 容器未运行，先启动"
  docker start "$CONTAINER" >/dev/null 2>&1 || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    docker ps --filter "name=^${CONTAINER}$" --filter status=running -q | grep -q . && break
    sleep 2
  done
fi

echo "==> 替换前端产物（/app/public）"
docker exec "$CONTAINER" sh -c 'rm -rf /app/public.new && mkdir -p /app/public.new'
docker cp "$WORK/web/." "$CONTAINER:/app/public.new/"
docker exec "$CONTAINER" sh -c 'rm -rf /app/public && mv /app/public.new /app/public'

if [ -d "$WORK/server/src" ]; then
  echo "==> 替换服务端代码（/app/src）"
  docker cp "$WORK/server/src/." "$CONTAINER:/app/src/"
fi
if [ -f "$WORK/server/package.json" ]; then
  docker cp "$WORK/server/package.json" "$CONTAINER:/app/package.json"
fi

echo "==> 重启容器"
docker restart "$CONTAINER" >/dev/null
sleep 5

echo "==> 健康检查"
# 服务端默认端口是 8888（server/src/index.js: PORT||8888）；18888 只是本地测试用的宿主映射。
# 显式设置 CHECKQ_PORT 时只试该端口，否则依次试默认 8888 与本地测试映射 18888。
HEALTH=""
# CHECKQ_PORT 只是“优先尝试”的端口；8888 在部分宿主上被 Basic Auth 反向代理占用，
# 显式锁定它会把健康检查误判为失败，所以仍保留 8888 / 18888 兜底。
for p in ${CHECKQ_PORT:+$CHECKQ_PORT }8888 18888; do
  H="$(curl -s --max-time 8 "http://127.0.0.1:${p}/api/health" || true)"
  echo "  端口 ${p}: ${H:-无响应}"
  case "$H" in *'"ok":true'*) HEALTH="$H"; break ;; esac
done
case "$HEALTH" in
  *'"ok":true'*) ;;
  *) echo "健康检查未通过：容器内文件已被替换，不会假装回滚" >&2
     echo "备份镜像 ${TAG}.bak 尚未被覆盖；需要人工确认后手动重建容器再恢复。" >&2
     exit 1 ;;
esac

echo "==> 提交为镜像 $TAG（容器重建后仍是新版本）"
docker commit "$CONTAINER" "$TAG" >/dev/null
rm -rf "$WORK"
echo "==> 完成"
