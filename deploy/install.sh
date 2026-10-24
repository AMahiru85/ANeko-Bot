#!/usr/bin/env bash

set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/AMahiru85/ANeko-Bot.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/qq-llm-agent}"
SERVICE_NAME="qq-llm-agent"
RUN_USER="qqbot"
NODE_MAJOR="22"

log() {
  printf '[qq-llm-agent] %s\n' "$*"
}

fail() {
  printf '[qq-llm-agent] 错误：%s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail "请使用 sudo 或 root 用户运行此脚本。"
  command -v apt-get >/dev/null 2>&1 || fail "此脚本需要 Ubuntu 或 Debian 的 apt-get。"
  command -v systemctl >/dev/null 2>&1 || fail "此脚本需要 systemd。"
}

install_system_packages() {
  log "安装 Git、curl 和 CA 证书..."
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates

  local node_ready="0"
  if command -v node >/dev/null 2>&1; then
    if node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 4) ? 0 : 1)'; then
      node_ready="1"
    fi
  fi

  if [[ "${node_ready}" != "1" ]]; then
    log "安装 Node.js ${NODE_MAJOR}..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi

  command -v node >/dev/null 2>&1 || fail "Node.js 安装失败。"
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!(major > 22 || (major === 22 && minor >= 4))) process.exit(1)' \
    || fail "Node.js 版本必须为 22.4 或更高。"
}

ensure_run_user() {
  if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
    log "创建运行用户 ${RUN_USER}..."
    useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${RUN_USER}"
  fi
}

install_project() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "更新已有项目..."
    git -c "safe.directory=${INSTALL_DIR}" -C "${INSTALL_DIR}" pull --ff-only
  elif [[ -e "${INSTALL_DIR}" ]]; then
    fail "${INSTALL_DIR} 已存在但不是 Git 仓库，请先处理该目录。"
  else
    log "拉取项目..."
    git clone "${REPO_URL}" "${INSTALL_DIR}"
  fi

  [[ -f "${INSTALL_DIR}/deploy/${SERVICE_NAME}.service" ]] \
    || fail "项目中缺少 deploy/${SERVICE_NAME}.service。"
  [[ -f "${INSTALL_DIR}/.env.example" ]] \
    || fail "项目中缺少 .env.example。"
}

prepare_environment() {
  local created="0"
  if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
    log "创建环境变量文件..."
    cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
    created="1"
  fi

  if [[ "${created}" == "1" ]] && [[ -r /dev/tty ]]; then
    configure_initial_environment
  fi
  chown "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}/.env"
  chmod 600 "${INSTALL_DIR}/.env"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local rendered_env
  rendered_env="$(mktemp)"
  KEY="${key}" VALUE="${value}" awk -F= '
    $1 == ENVIRON["KEY"] {
      print ENVIRON["KEY"] "=" ENVIRON["VALUE"]
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) print ENVIRON["KEY"] "=" ENVIRON["VALUE"]
    }
  ' "${INSTALL_DIR}/.env" > "${rendered_env}"
  mv "${rendered_env}" "${INSTALL_DIR}/.env"
}

configure_initial_environment() {
  local qq_app_id=""
  local qq_client_secret=""
  local llm_api_key=""

  log "首次部署可直接填写必填密钥（输入内容不会回显）。"
  read -r -p "QQ_APP_ID: " qq_app_id < /dev/tty || true
  read -r -s -p "QQ_CLIENT_SECRET: " qq_client_secret < /dev/tty || true
  printf '\n' > /dev/tty
  read -r -s -p "LLM_API_KEY: " llm_api_key < /dev/tty || true
  printf '\n' > /dev/tty

  if [[ -z "${qq_app_id}" || -z "${qq_client_secret}" || -z "${llm_api_key}" ]]; then
    log "检测到必填密钥为空，将保留模板并跳过启动。"
    return 0
  fi

  set_env_value "QQ_APP_ID" "${qq_app_id}"
  set_env_value "QQ_CLIENT_SECRET" "${qq_client_secret}"
  set_env_value "LLM_API_KEY" "${llm_api_key}"
}

has_config_value() {
  local key="$1"
  awk -F= -v key="${key}" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value != "") found = 1
    }
    END { exit(found ? 0 : 1) }
  ' "${INSTALL_DIR}/.env"
}

validate_environment() {
  local missing=()
  local key
  for key in QQ_APP_ID QQ_CLIENT_SECRET LLM_API_KEY; do
    if ! has_config_value "${key}"; then
      missing+=("${key}")
    fi
  done

  if ((${#missing[@]} > 0)); then
    log "以下必填配置还没有填写：${missing[*]}"
    return 1
  fi
  return 0
}

install_service() {
  log "安装并启动 systemd 服务..."
  local rendered_service
  rendered_service="$(mktemp)"
  sed \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=${INSTALL_DIR}/.env|" \
    -e "s|^ExecStart=.*|ExecStart=/usr/bin/node ${INSTALL_DIR}/src/index.mjs|" \
    "${INSTALL_DIR}/deploy/${SERVICE_NAME}.service" > "${rendered_service}"
  install -o root -g root -m 0644 \
    "${rendered_service}" \
    "/etc/systemd/system/${SERVICE_NAME}.service"
  rm -f "${rendered_service}"
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    systemctl restart "${SERVICE_NAME}"
  else
    systemctl start "${SERVICE_NAME}"
  fi
}

print_next_steps() {
  cat <<EOF

项目已部署到：${INSTALL_DIR}
请先编辑配置文件：

  sudo nano ${INSTALL_DIR}/.env

配置完成后重新执行：

  sudo bash ${INSTALL_DIR}/deploy/install.sh

查看状态和日志：

  sudo systemctl status ${SERVICE_NAME}
  sudo journalctl -u ${SERVICE_NAME} -f
EOF
}

main() {
  require_root
  install_system_packages
  ensure_run_user
  install_project
  chown -R "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}"
  prepare_environment

  if ! validate_environment; then
    print_next_steps
    exit 0
  fi

  install_service
  log "部署完成。健康检查：curl http://127.0.0.1:3000/health"
}

main "$@"
