# check=skip=InvalidDefaultArgInFrom
ARG NGINX_VERSION
FROM nginx:${NGINX_VERSION}

ARG NODE_FRONTEND_VERSION
USER root

# Gulp still generates environment-specific AngularJS configuration when the container starts.
# Install the exact Node line declared by cedar-docker-build and verify the upstream checksum.
RUN set -eux; \
    test -n "$NODE_FRONTEND_VERSION"; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    case "$(dpkg --print-architecture)" in \
      amd64) nodearch=x64 ;; \
      arm64) nodearch=arm64 ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)"; exit 1 ;; \
    esac; \
    tarball="node-v${NODE_FRONTEND_VERSION}-linux-${nodearch}.tar.xz"; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_FRONTEND_VERSION}/${tarball}"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_FRONTEND_VERSION}/SHASUMS256.txt"; \
    grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "$tarball" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "$tarball" SHASUMS256.txt; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /srv/cedar/cedar-template-designer
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# Keep source identity after the expensive, lockfile-keyed dependency layer so a
# new commit does not force npm to reinstall an unchanged dependency graph.
ARG CEDAR_SOURCE_COMMIT=unknown
ARG CEDAR_SOURCE_DIRTY=unknown
LABEL org.opencontainers.image.revision="${CEDAR_SOURCE_COMMIT}"
LABEL org.metadatacenter.cedar.source-dirty="${CEDAR_SOURCE_DIRTY}"
COPY . ./
RUN printf '%s\n' "$CEDAR_SOURCE_COMMIT" > /usr/local/share/cedar-source-commit \
    && printf '%s\n' "$CEDAR_SOURCE_DIRTY" > /usr/local/share/cedar-source-dirty

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/entrypoint.sh /docker-entrypoint.sh
RUN chmod 0755 /docker-entrypoint.sh && mkdir -p /log

VOLUME ["/log"]
EXPOSE 4202
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4202/config/version.js >/dev/null || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
