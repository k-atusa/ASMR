#!/bin/sh
set -euo pipefail

ENV_JS_PATH="/usr/share/nginx/html/env.js"
NGINX_CONF_PATH="/etc/nginx/conf.d/default.conf"
RUNTIME_BASE="${ICECAST_BASE_URL:-}"
UPSTREAM_HOST=""
UPSTREAM_SCHEME=""

if [ -n "$RUNTIME_BASE" ]; then
  UPSTREAM_HOST=$(printf '%s' "$RUNTIME_BASE" | sed -E 's#^[a-zA-Z]+://([^/:]+).*$#\1#')
  UPSTREAM_SCHEME=$(printf '%s' "$RUNTIME_BASE" | sed -E 's#^([a-zA-Z]+)://.*$#\1#')
fi

cat >"${ENV_JS_PATH}" <<EOF
window.__ICECAST_RUNTIME_CONFIG__ = {
  ICECAST_BASE_URL: "${RUNTIME_BASE}"
};
EOF

if [ -n "${RUNTIME_BASE}" ]; then
  cat >"${NGINX_CONF_PATH}" <<EOF
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  location / {
    try_files \$uri \$uri/ /index.html;
  }

  location /icecast-status {
    proxy_pass ${RUNTIME_BASE}/status-json.xsl;
    proxy_set_header Host ${UPSTREAM_HOST};
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
$(if [ "$UPSTREAM_SCHEME" = "https" ]; then printf '    proxy_ssl_server_name on;\n    proxy_ssl_name %s;\n' "$UPSTREAM_HOST"; fi)
  }

  location /icecast-stream {
    proxy_pass ${RUNTIME_BASE}/stream;
    proxy_set_header Host ${UPSTREAM_HOST};
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
$(if [ "$UPSTREAM_SCHEME" = "https" ]; then printf '    proxy_ssl_server_name on;\n    proxy_ssl_name %s;\n' "$UPSTREAM_HOST"; fi)
  }
}
EOF
else
  cat >"${NGINX_CONF_PATH}" <<'EOF'
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }
}
EOF
fi

exec "$@"
