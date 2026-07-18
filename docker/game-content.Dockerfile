# 游戏内容镜像：只装素材 + DB 种子，不含引擎。
# 启动时把内容投放到共享卷然后退出，server 用 depends_on 等它跑完。
#
# 素材有 1-2.4G，用 --build-context 直接指到 resources/<slug>，
# 避免把整个 repo 当 build context 喂给 buildkit。由 `just release-game <slug>` 调用：
#
#   docker buildx build -f docker/game-content.Dockerfile \
#     --build-context assets=resources/sword2 \
#     --build-context seed=.data/game-seeds \
#     --build-arg SLUG=sword2 --build-arg REV=$(git rev-parse --short HEAD) \
#     docker/

FROM alpine:3.22

ARG SLUG
ARG REV

COPY --from=assets . /game/assets/
COPY --from=seed ${SLUG}.json /game/seed.json
COPY game-content-entrypoint.sh /usr/local/bin/game-content-entrypoint

RUN printf '%s' "${SLUG}" > /game/slug \
    && printf '%s' "${REV}" > /game/rev \
    && chmod +x /usr/local/bin/game-content-entrypoint

ENTRYPOINT ["/usr/local/bin/game-content-entrypoint"]
