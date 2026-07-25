#!/usr/bin/env bash
#
# Connectivity smoke test for the Threadmark local stack.
# Run from the repo root (via `pnpm infra:smoke`) AFTER `pnpm infra:up`.
#
# Verifies each service is reachable and, for Postgres, that pgvector works.
# Exits non-zero if any check fails.

set -uo pipefail

# Resolve repo root as the directory two levels up from this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
else
  echo "!! .env not found — copy .env.example to .env first (cp .env.example .env)"
  exit 1
fi

COMPOSE=(docker compose --env-file .env -f infra/docker/docker-compose.yml)

OPENSEARCH_PORT="${OPENSEARCH_PORT:-9200}"
MINIO_API_PORT="${MINIO_API_PORT:-9000}"
TEMPORAL_UI_PORT="${TEMPORAL_UI_PORT:-8233}"
JAEGER_UI_PORT="${JAEGER_UI_PORT:-16686}"
POSTGRES_USER="${POSTGRES_USER:-threadmark}"
POSTGRES_DB="${POSTGRES_DB:-threadmark}"

failures=0

# retry <attempts> <sleep-seconds> <command...>
retry() {
  local attempts="$1" delay="$2"
  shift 2
  local i
  for ((i = 1; i <= attempts; i++)); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${delay}"
  done
  return 1
}

check() {
  local name="$1"
  shift
  printf '  %-14s ' "${name}"
  if retry 30 2 "$@"; then
    echo "OK"
  else
    echo "FAIL"
    failures=$((failures + 1))
  fi
}

pg_vector_ok() {
  "${COMPOSE[@]}" exec -T postgres \
    psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc "SELECT '[1,2,3]'::vector;" \
    | grep -q '\[1,2,3\]'
}

redis_ok() {
  "${COMPOSE[@]}" exec -T redis redis-cli ping | grep -q 'PONG'
}

echo "Threadmark infra smoke test"
check "postgres"     pg_vector_ok
check "redis"        redis_ok
check "opensearch"   curl -sf "http://localhost:${OPENSEARCH_PORT}/_cluster/health"
check "minio"        curl -sf "http://localhost:${MINIO_API_PORT}/minio/health/live"
check "temporal-ui"  curl -sf "http://localhost:${TEMPORAL_UI_PORT}/"
check "jaeger"       curl -sf "http://localhost:${JAEGER_UI_PORT}/"

echo
if [[ "${failures}" -eq 0 ]]; then
  echo "All services healthy"
  exit 0
fi
echo "${failures} service(s) failed — check 'pnpm infra:logs'"
exit 1
