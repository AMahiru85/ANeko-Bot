#!/usr/bin/env bash

set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/AMahiru85/ANeko-Bot.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/qq-llm-agent}"
SERVICE_NAME="qq-llm-agent"
RUN_USER="qqbot"
NODE_MAJOR="22"
TTY_ECHO_STATE=""

restore_tty() {
  if [[ -n "${TTY_ECHO_STATE}" ]]; then
    stty "${TTY_ECHO_STATE}" < /dev/tty 2>/dev/null || true
    TTY_ECHO_STATE=""
  fi
}

trap restore_tty EXIT

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
  DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates nano

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

ensure_project() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "项目已存在，保留当前代码。"
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

update_project() {
  [[ -d "${INSTALL_DIR}/.git" ]] \
    || fail "尚未安装 ANeko-Bot，请先选择安装。"
  log "拉取最新代码..."
  git -c "safe.directory=${INSTALL_DIR}" -C "${INSTALL_DIR}" pull --ff-only
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
  local env_file="${3:-${INSTALL_DIR}/.env}"
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
  ' "${env_file}" > "${rendered_env}"
  mv "${rendered_env}" "${env_file}"
}

get_env_value() {
  local key="$1"
  local env_file="${2:-${INSTALL_DIR}/.env}"
  awk -F= -v key="${key}" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      single_quote = sprintf("%c", 39)
      if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") || (substr(value, 1, 1) == single_quote && substr(value, length(value), 1) == single_quote)) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "${env_file}"
}

read_tty_value() {
  local prompt="$1"
  local secret="${2:-0}"
  REPLY=""
  printf '%s' "${prompt}" > /dev/tty
  if [[ "${secret}" == "1" ]]; then
    TTY_ECHO_STATE="$(stty -g < /dev/tty)"
    stty -echo < /dev/tty
    IFS= read -r REPLY < /dev/tty || true
    restore_tty
    printf '\n' > /dev/tty
  else
    IFS= read -r REPLY < /dev/tty || true
  fi
}

configure_initial_environment() {
  local -a keys=(
    QQ_APP_ID QQ_CLIENT_SECRET QQ_API_BASE QQ_GATEWAY_URL QQ_INTENTS
    LLM_API_KEY LLM_BASE_URL LLM_MODEL SYSTEM_PROMPT HTTP_PORT
  )
  local -a labels=(
    QQ_APP_ID QQ_CLIENT_SECRET QQ_API_BASE QQ_GATEWAY_URL QQ_INTENTS
    LLM_API_KEY LLM_BASE_URL LLM_MODEL SYSTEM_PROMPT HTTP_PORT
  )
  local -a required=(1 1 0 0 0 1 0 0 0 0)
  local -a secret=(0 1 0 0 0 1 0 0 0 0)
  local -a values=()
  local index=0
  local key=""
  local label=""
  local default=""
  local value=""
  local confirmation=""
  local prompt=""
  local rendered_env=""

  log "首次安装将逐项配置全部环境变量。"
  log "可选项直接回车使用默认值；输入 :back 返回上一项，输入 :cancel 取消配置。"
  log "QQ_CLIENT_SECRET 和 LLM_API_KEY 输入时不会回显，输入后按回车即可。"

  while ((index < ${#keys[@]})); do
    key="${keys[index]}"
    label="${labels[index]}"
    default="$(get_env_value "${key}")"
    if [[ "${required[index]}" == "1" ]]; then
      prompt="${label}（必填，输入 :back 返回上一项，:cancel 取消）： "
    elif [[ -n "${default}" ]]; then
      prompt="${label}（回车使用默认值：${default}；输入 :back 返回上一项）： "
    else
      prompt="${label}（回车留空；输入 :back 返回上一项）： "
    fi

    read_tty_value "${prompt}" "${secret[index]}"
    value="${REPLY}"
    if [[ "${value}" == ":cancel" ]]; then
      log "已取消配置，保留当前模板。"
      return 0
    fi
    if [[ "${value}" == ":back" ]]; then
      if ((index > 0)); then
        index=$((index - 1))
      else
        log "已经是第一项，无法继续回退。"
      fi
      continue
    fi
    if [[ "${required[index]}" == "1" && -z "${value}" ]]; then
      log "${label} 为必填项，不能为空。"
      continue
    fi
    if [[ "${required[index]}" != "1" && -z "${value}" ]]; then
      value="${default}"
    fi

    if [[ "${required[index]}" == "1" ]]; then
      read_tty_value "请再次输入 ${label} 确认（输入 :back 返回上一项）： " "${secret[index]}"
      confirmation="${REPLY}"
      if [[ "${confirmation}" == ":cancel" ]]; then
        log "已取消配置，保留当前模板。"
        return 0
      fi
      if [[ "${confirmation}" == ":back" ]]; then
        if ((index > 0)); then
          index=$((index - 1))
        else
          log "已经是第一项，无法继续回退。"
        fi
        continue
      fi
      if [[ "${value}" != "${confirmation}" ]]; then
        log "两次输入不一致，请重新填写 ${label}。"
        continue
      fi
    fi

    values[index]="${value}"
    index=$((index + 1))
  done

  rendered_env="$(mktemp)"
  cp "${INSTALL_DIR}/.env" "${rendered_env}"
  for index in "${!keys[@]}"; do
    set_env_value "${keys[index]}" "${values[index]}" "${rendered_env}"
  done
  mv "${rendered_env}" "${INSTALL_DIR}/.env"
  log "环境变量配置完成。"
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

install_service_unit() {
  log "安装 systemd 服务配置..."
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
}

start_or_restart_service() {
  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    systemctl restart "${SERVICE_NAME}"
  else
    systemctl start "${SERVICE_NAME}"
  fi
}

install_service() {
  install_service_unit
  start_or_restart_service
}

restart_service() {
  require_service
  log "重启 ${SERVICE_NAME}..."
  systemctl restart "${SERVICE_NAME}"
}

stop_service() {
  require_service
  log "停止 ${SERVICE_NAME}..."
  systemctl stop "${SERVICE_NAME}"
}

require_service() {
  systemctl cat "${SERVICE_NAME}" >/dev/null 2>&1 \
    || fail "systemd 服务 ${SERVICE_NAME} 尚未安装。"
}

show_service_status() {
  require_service
  systemctl status "${SERVICE_NAME}" --no-pager || true
  if systemctl is-active --quiet "${SERVICE_NAME}" && command -v curl >/dev/null 2>&1; then
    printf '\n健康检查：\n'
    curl --fail --silent --show-error http://127.0.0.1:3000/health || true
    printf '\n'
  fi
}

remove_service() {
  if systemctl cat "${SERVICE_NAME}" >/dev/null 2>&1; then
    systemctl disable --now "${SERVICE_NAME}" || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
  fi
}

print_next_steps() {
  cat <<EOF

项目已部署到：${INSTALL_DIR}
请先编辑配置文件：

  sudo nano ${INSTALL_DIR}/.env

配置完成后重新执行：

  sudo bash ${INSTALL_DIR}/deploy/install.sh --install

查看状态和日志：

  sudo systemctl status ${SERVICE_NAME}
  sudo journalctl -u ${SERVICE_NAME} -f
EOF
}

install_bot() {
  install_system_packages
  ensure_run_user
  ensure_project
  chown -R "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}"
  prepare_environment

  if ! validate_environment; then
    print_next_steps
    return 0
  fi

  install_service
  log "部署完成。健康检查：curl http://127.0.0.1:3000/health"
}

upgrade_bot() {
  command -v git >/dev/null 2>&1 || fail "未找到 Git，请先选择安装。"
  update_project
  [[ -f "${INSTALL_DIR}/deploy/${SERVICE_NAME}.service" ]] \
    || fail "项目中缺少 deploy/${SERVICE_NAME}.service。"
  [[ -f "${INSTALL_DIR}/.env.example" ]] \
    || fail "项目中缺少 .env.example。"
  ensure_run_user
  chown -R "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}"
  prepare_environment

  if ! validate_environment; then
    print_next_steps
    return 0
  fi

  install_service
  log "ANeko-Bot 升级完成。"
}

update_config() {
  [[ -d "${INSTALL_DIR}" ]] || fail "尚未安装 ANeko-Bot。"
  [[ -f "${INSTALL_DIR}/.env.example" ]] \
    || fail "项目中缺少 .env.example。"
  ensure_run_user
  if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
    cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
  fi
  chown "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}/.env"
  chmod 600 "${INSTALL_DIR}/.env"

  local editor_default="nano"
  command -v "${editor_default}" >/dev/null 2>&1 || editor_default="vi"
  local -a editor_command
  read -r -a editor_command <<< "${EDITOR:-${editor_default}}"
  ((${#editor_command[@]} > 0)) || fail "EDITOR 为空。"
  command -v "${editor_command[0]}" >/dev/null 2>&1 \
    || fail "找不到编辑器 ${editor_command[0]}，请安装 nano 或设置 EDITOR。"
  "${editor_command[@]}" "${INSTALL_DIR}/.env"
  chown "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}/.env"
  chmod 600 "${INSTALL_DIR}/.env"

  if ! validate_environment; then
    log "配置未完整填写，服务没有重启。"
    return 0
  fi
  if systemctl cat "${SERVICE_NAME}" >/dev/null 2>&1; then
    restart_service
  else
    log "配置已更新，服务尚未安装。"
  fi
}

uninstall_bot() {
  local answer=""
  printf '确定要卸载 ANeko-Bot 及其配置吗？输入 UNINSTALL 确认：' > /dev/tty
  read -r answer < /dev/tty || true
  [[ "${answer}" == "UNINSTALL" ]] || {
    log "已取消卸载。"
    return 0
  }

  local user_home=""
  if id -u "${RUN_USER}" >/dev/null 2>&1; then
    user_home="$(getent passwd "${RUN_USER}" | cut -d: -f6)"
  fi
  remove_service
  [[ "${INSTALL_DIR}" != "/" && "${INSTALL_DIR}" != "/opt" ]] \
    || fail "拒绝删除危险安装目录 ${INSTALL_DIR}。"
  rm -rf -- "${INSTALL_DIR}"
  if [[ "${user_home}" == "${INSTALL_DIR}" ]]; then
    userdel "${RUN_USER}" 2>/dev/null || log "运行用户 ${RUN_USER} 未能自动删除，请手动处理。"
  fi
  log "ANeko-Bot 已卸载。"
  return 10
}

pause_menu() {
  printf '\n按 Enter 返回管理菜单...' > /dev/tty
  read -r < /dev/tty || true
}

run_menu_action() {
  local action="$1"
  local code=0
  if ("${action}"); then
    code=0
  else
    code=$?
  fi
  if ((code == 10)); then
    return 10
  fi
  if ((code != 0)); then
    log "操作失败，请查看上面的错误信息。"
  fi
  return 0
}

show_menu() {
  while true; do
    cat > /dev/tty <<EOF

========================================
          ANeko-Bot 管理菜单
========================================
1. 安装 ANeko-Bot
2. 升级 ANeko-Bot
3. 卸载 ANeko-Bot
4. 更新配置
5. 查看服务状态
6. 重启服务
7. 停止服务
0. 退出
========================================
EOF
    local choice=""
    printf '请选择操作 [0-7]: ' > /dev/tty
    read -r choice < /dev/tty || return 0
    local action=""
    case "${choice}" in
      1) action="install_bot" ;;
      2) action="upgrade_bot" ;;
      3) action="uninstall_bot" ;;
      4) action="update_config" ;;
      5) action="show_service_status" ;;
      6) action="restart_service" ;;
      7) action="stop_service" ;;
      0) return 0 ;;
      *) log "无效选项。"; pause_menu; continue ;;
    esac

    local code=0
    if run_menu_action "${action}"; then
      code=0
    else
      code=$?
    fi
    ((code == 10)) && return 0
    pause_menu
  done
}

main() {
  require_root
  case "${1:-menu}" in
    menu|--menu)
      if [[ -r /dev/tty ]]; then
        show_menu
      else
        install_bot
      fi
      ;;
    install|--install) install_bot ;;
    upgrade|--upgrade) upgrade_bot ;;
    uninstall|--uninstall) uninstall_bot ;;
    config|--config) update_config ;;
    status|--status) show_service_status ;;
    restart|--restart) restart_service ;;
    stop|--stop) stop_service ;;
    *)
      fail "未知参数 ${1}。可用参数：--menu、--install、--upgrade、--uninstall、--config、--status、--restart、--stop。"
      ;;
  esac
}

main "$@"
