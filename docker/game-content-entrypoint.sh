#!/bin/sh
# 把镜像内的游戏素材和种子投放到共享卷，然后退出（init 容器用法）。
# rev 相同就跳过素材拷贝——否则每次重启都要重拷 1-2.4G。
set -eu

SLUG="$(cat /game/slug)"
REV="$(cat /game/rev)"
DEST="/assets/$SLUG"

if [ -f "$DEST/.image-rev" ] && [ "$(cat "$DEST/.image-rev")" = "$REV" ]; then
  echo "[game-content] $SLUG: assets up-to-date ($REV)"
else
  echo "[game-content] $SLUG: installing assets ($REV) ..."
  TMP="/assets/.tmp-$SLUG"
  rm -rf "$TMP"
  mkdir -p "$TMP"
  cp -a /game/assets/. "$TMP/"
  echo "$REV" > "$TMP/.image-rev"
  # 同卷内 rename，换入瞬间完成；server 由 depends_on 挡在本容器退出之后才起
  rm -rf "$DEST"
  mv "$TMP" "$DEST"
  echo "[game-content] $SLUG: assets installed"
fi

# 种子每次都覆盖（很小）。库里已有该 slug 时 server 会跳过播种，所以这里覆盖不会动线上数据
mkdir -p /seeds
cp /game/seed.json "/seeds/$SLUG.json"
echo "[game-content] $SLUG: seed placed at /seeds/$SLUG.json"
