#!/bin/sh
# Creates a self-signed certificate for compose.yaml's HTTPS proxy (run by the nginx image's
# entrypoint before nginx starts). It is kept in the mesh-client-tls volume and created again when
# MESH_CLIENT_TLS_NAMES changes. Browsers warn about it until you accept it or trust the
# certificate (copy it out with: docker compose cp https:/etc/nginx/tls/mesh-client.crt .).
set -eu

TLS_DIR=/etc/nginx/tls
NAMES="${MESH_CLIENT_TLS_NAMES:-DNS:localhost,IP:127.0.0.1}"

# subjectAltName entries only: DNS:<name> or IP:<address>, comma-separated (no globbing, so
# wildcard names such as DNS:*.lan stay as written).
set -f
for entry in $(printf '%s' "$NAMES" | tr ',' ' '); do
  case "$entry" in
    DNS:?* | IP:?*) ;;
    *)
      echo "mesh-client: MESH_CLIENT_TLS_NAMES entry '$entry' must be DNS:<name> or IP:<address>" >&2
      exit 1
      ;;
  esac
done
set +f

mkdir -p "$TLS_DIR"
if [ -s "$TLS_DIR/mesh-client.crt" ] && [ -s "$TLS_DIR/mesh-client.key" ] \
  && [ "$(cat "$TLS_DIR/names" 2> /dev/null)" = "$NAMES" ]; then
  echo "mesh-client: using the existing certificate for $NAMES"
  exit 0
fi

echo "mesh-client: creating a self-signed certificate for $NAMES"
umask 077
openssl req -x509 -nodes -days 825 \
  -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$TLS_DIR/mesh-client.key" -out "$TLS_DIR/mesh-client.crt" \
  -subj "/CN=Mesh Client (self-signed)" \
  -addext "subjectAltName=$NAMES" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=serverAuth"
chmod 644 "$TLS_DIR/mesh-client.crt"
printf '%s' "$NAMES" > "$TLS_DIR/names"
openssl x509 -in "$TLS_DIR/mesh-client.crt" -noout -fingerprint -sha256
