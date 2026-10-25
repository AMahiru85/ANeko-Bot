#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/AMahiru85/ANeko-Bot.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/qq-llm-agent}"
SERVICE_NAME="qq-llm-agent"
RUN_USER="qqbot"
CONFIG_CANCELLED=0

log() { printf '[%s] %s\n' "${SERVICE_NAME}" "$*"; }
die() { log "错误：$*" >&2; exit 1; }

root_check() {
  [[ "${EUID}" -eq 0 ]] || die "请使用 sudo 或 root 用户运行。"
  command -v apt-get >/dev/null || die "此脚本需要 Ubuntu/Debian 的 apt-get。"
  command -v systemctl >/dev/null || die "此脚本需要 systemd。"
}

install_deps() {
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates nano
  if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 4) ? 0 : 1)' 2>/dev/null; then
    log "安装 Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi
  command -v node >/dev/null || die "Node.js 安装失败。"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (!(a > 22 || (a === 22 && b >= 4))) process.exit(1)' \
    || die "Node.js 版本必须为 22.4 或更高。"
}

ensure_user() {
  if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
    useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${RUN_USER}"
  fi
}

check_project() {
  [[ -f "${INSTALL_DIR}/deploy/${SERVICE_NAME}.service" ]] || die "缺少 systemd 服务文件。"
  [[ -f "${INSTALL_DIR}/.env.example" ]] || die "缺少 .env.example。"
}

install_project() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "项目已存在，保留当前代码。"
  elif [[ -e "${INSTALL_DIR}" ]]; then
    die "${INSTALL_DIR} 已存在但不是 Git 仓库。"
  else
    git clone "${REPO_URL}" "${INSTALL_DIR}"
  fi
  check_project
}

upgrade_project() {
  [[ -d "${INSTALL_DIR}/.git" ]] || die "尚未安装 ANeko-Bot。"
  git -c "safe.directory=${INSTALL_DIR}" -C "${INSTALL_DIR}" pull --ff-only
  check_project
}

env_get() {
  local key="$1" file="${2:-${INSTALL_DIR}/.env}"
  awk -F= -v key="${key}" '$1 == key { value=substr($0,index($0,"=")+1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); print value; exit }' "${file}"
}

env_set() {
  local key="$1" value="$2" file="${3:-${INSTALL_DIR}/.env}" tmp
  tmp="$(mktemp)"
  KEY="${key}" VALUE="${value}" awk -F= '
    $1 == ENVIRON["KEY"] { print ENVIRON["KEY"] "=" ENVIRON["VALUE"]; found=1; next }
    { print }
    END { if (!found) print ENVIRON["KEY"] "=" ENVIRON["VALUE"] }
  ' "${file}" > "${tmp}"
  mv "${tmp}" "${file}"
}

read_tty() {
  local prompt="$1"
  REPLY=""
  printf '%s' "${prompt}" > /dev/tty
  IFS= read -r REPLY < /dev/tty || true
}

env_description() {
  case "$1" in
    AI_PROVIDER) printf 'AI 服务商：deepseek 或 other' ;;
    QQ_APP_ID) printf 'QQ 机器人 AppID' ;;
    QQ_CLIENT_SECRET) printf 'QQ 机器人 AppSecret' ;;
    QQ_API_BASE) printf 'QQ OpenAPI 地址' ;;
    QQ_GATEWAY_URL) printf '自定义 Gateway 地址' ;;
    QQ_INTENTS) printf 'Gateway Identify 位掩码' ;;
    DEEPSEEK_API_KEY) printf 'DeepSeek API Key' ;;
    DEEPSEEK_BASE_URL) printf 'DeepSeek API 地址（官方地址可留空）' ;;
    DEEPSEEK_MODEL) printf 'DeepSeek 模型名称' ;;
    OTHER_AI_BASE_URL) printf '其他 AI 的 OpenAI 兼容 API 地址' ;;
    OTHER_AI_API_KEY) printf '其他 AI 的 API Key' ;;
    OTHER_AI_MODEL) printf '其他 AI 的模型名称' ;;
    LLM_REASONING_EFFORT) printf '默认思考等级：none、minimal、low、medium、high、xhigh' ;;
    SYSTEM_PROMPT) printf 'Agent 的系统提示词' ;;
    HTTP_PORT) printf '本机健康检查端口' ;;
    *) printf '%s' "$1" ;;
  esac
}

configure_env() {
  local preserve_existing="${1:-0}"
  local provider provider_default provider_input
  local -a keys=(QQ_APP_ID QQ_CLIENT_SECRET QQ_API_BASE QQ_GATEWAY_URL QQ_INTENTS LLM_REASONING_EFFORT SYSTEM_PROMPT HTTP_PORT)
  local -a required=(1 1 0 0 0 0 0 0)
  local -a values=()
  local i=0 key description default value confirm prompt tmp kept_existing

  CONFIG_CANCELLED=0
  log "配置环境变量..."
  if [[ "${preserve_existing}" == 1 ]]; then
    log '已有值留空则保持原设置；空值项目留空则使用默认值。输入 `:back` 返回上一项，输入 `:cancel` 取消本次配置。'
  else
    log '可选项留空则使用默认值。输入 `:back` 返回上一项，输入 `:cancel` 取消本次配置。'
  fi

  provider_default="$(env_get AI_PROVIDER)"
  [[ -n "${provider_default}" ]] || provider_default="deepseek"
  provider_default="${provider_default,,}"
  if [[ "${preserve_existing}" == 1 && -n "$(env_get AI_PROVIDER)" ]]; then
    prompt="AI_PROVIDER（deepseek 或 other，回车保留当前值，:cancel 取消）： "
  else
    prompt="AI_PROVIDER（deepseek 或 other，回车使用 ${provider_default}，:cancel 取消）： "
  fi
  read_tty "${prompt}"
  provider_input="${REPLY,,}"
  case "${provider_input}" in
    :cancel) CONFIG_CANCELLED=1; log "已取消配置。"; return 0 ;;
    "") provider="${provider_default}" ;;
    deepseek) provider="deepseek" ;;
    other) provider="other" ;;
    *) log "AI_PROVIDER 只能是 deepseek 或 other。"; return 0 ;;
  esac

  if [[ "${provider}" == deepseek ]]; then
    keys+=(DEEPSEEK_API_KEY DEEPSEEK_MODEL DEEPSEEK_BASE_URL)
    required+=(1 0 0)
    log "已选择 DeepSeek：使用 https://api.deepseek.com 默认地址。"
  else
    keys+=(OTHER_AI_BASE_URL OTHER_AI_API_KEY OTHER_AI_MODEL)
    required+=(1 1 1)
    log "已选择其他 AI：需要填写 OpenAI 兼容地址、API Key 和模型。"
  fi

  while ((i < ${#keys[@]})); do
    key="${keys[i]}"
    description="$(env_description "${key}")"
    default="$(env_get "${key}")"
    if [[ "${key}" == DEEPSEEK_MODEL && -z "${default}" ]]; then default="deepseek-flash"; fi
    kept_existing=0
    if [[ "${required[i]}" == 1 ]]; then
      if [[ "${preserve_existing}" == 1 && -n "${default}" ]]; then
        prompt="${key}（${description}，回车保留当前值，:back 返回，:cancel 取消）： "
      else
        prompt="${key}（${description}，必填，:back 返回，:cancel 取消）： "
      fi
    elif [[ -n "${default}" ]]; then
      if [[ "${preserve_existing}" == 1 ]]; then
        prompt="${key}（${description}，回车保留当前值，:back 返回，:cancel 取消）： "
      else
        prompt="${key}（${description}，回车使用默认值 ${default}，:back 返回）： "
      fi
    else
      prompt="${key}（${description}，回车留空，:back 返回，:cancel 取消）： "
    fi

    read_tty "${prompt}"
    value="${REPLY}"
    case "${value}" in
      :cancel) CONFIG_CANCELLED=1; log "已取消配置。"; return 0 ;;
      :back) if ((i > 0)); then i=$((i - 1)); else log "已经是第一项。"; fi; continue ;;
    esac
    if [[ -z "${value}" ]]; then
      if [[ "${preserve_existing}" == 1 && -n "${default}" ]]; then
        value="${default}"
        kept_existing=1
      elif [[ "${required[i]}" == 1 ]]; then
        log "${key} 不能为空。"
        continue
      else
        value="${default}"
      fi
    fi

    if [[ "${required[i]}" == 1 && "${kept_existing}" == 0 ]]; then
      read_tty "再次输入 ${key}（${description}）确认（:back 返回）： "
      confirm="${REPLY}"
      case "${confirm}" in
        :cancel) CONFIG_CANCELLED=1; log "已取消配置。"; return 0 ;;
        :back) if ((i > 0)); then i=$((i - 1)); else log "已经是第一项。"; fi; continue ;;
      esac
      if [[ "${value}" != "${confirm}" ]]; then
        log "两次输入不一致，请重新填写 ${key}。"
        continue
      fi
    fi
    values[i]="${value}"
    i=$((i + 1))
  done

  tmp="$(mktemp)"
  cp "${INSTALL_DIR}/.env" "${tmp}"
  env_set AI_PROVIDER "${provider}" "${tmp}"
  for i in "${!keys[@]}"; do env_set "${keys[i]}" "${values[i]}" "${tmp}"; done
  mv "${tmp}" "${INSTALL_DIR}/.env"
  log "环境变量配置完成。"
}

ensure_env() {
  local new=0
  if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
    log "创建环境变量文件..."
    cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
    new=1
  fi
  if ((new)) && [[ -r /dev/tty ]]; then configure_env 0; fi
  chown "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}/.env"
  chmod 600 "${INSTALL_DIR}/.env"
}

valid_env() {
  local key provider missing=()
  for key in QQ_APP_ID QQ_CLIENT_SECRET; do
    [[ -n "$(env_get "${key}")" ]] || missing+=("${key}")
  done
  provider="$(env_get AI_PROVIDER)"
  [[ -n "${provider}" ]] || provider="deepseek"
  provider="${provider,,}"
  case "${provider}" in
    deepseek)
      [[ -n "$(env_get DEEPSEEK_API_KEY)" ]] || missing+=(DEEPSEEK_API_KEY)
      ;;
    other)
      [[ -n "$(env_get OTHER_AI_BASE_URL)" ]] || missing+=(OTHER_AI_BASE_URL)
      [[ -n "$(env_get OTHER_AI_API_KEY)" ]] || missing+=(OTHER_AI_API_KEY)
      [[ -n "$(env_get OTHER_AI_MODEL)" ]] || missing+=(OTHER_AI_MODEL)
      ;;
    *) missing+=("AI_PROVIDER(deepseek|other)") ;;
  esac
  if ((${#missing[@]})); then
    log "未填写必填变量：${missing[*]}"
    return 1
  fi
}

install_unit() {
  local tmp
  tmp="$(mktemp)"
  sed -e "s|^WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
      -e "s|^EnvironmentFile=.*|EnvironmentFile=${INSTALL_DIR}/.env|" \
      -e "s|^ExecStart=.*|ExecStart=/usr/bin/node ${INSTALL_DIR}/src/index.mjs|" \
      "${INSTALL_DIR}/deploy/${SERVICE_NAME}.service" > "${tmp}"
  install -o root -g root -m 0644 "${tmp}" "/etc/systemd/system/${SERVICE_NAME}.service"
  rm -f "${tmp}"
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
}

has_service() { systemctl cat "${SERVICE_NAME}" >/dev/null 2>&1; }
start_service() { if systemctl is-active --quiet "${SERVICE_NAME}"; then systemctl restart "${SERVICE_NAME}"; else systemctl start "${SERVICE_NAME}"; fi; }
restart_service() { has_service || die "服务尚未安装。"; systemctl restart "${SERVICE_NAME}"; }
stop_service() { has_service || die "服务尚未安装。"; systemctl stop "${SERVICE_NAME}"; }

install_bot() {
  install_deps; ensure_user; install_project
  chown -R "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}"
  ensure_env
  if ! valid_env; then
    log "请编辑 ${INSTALL_DIR}/.env 后重新执行 --install。"
    return 0
  fi
  install_unit; start_service
  log "安装完成。健康检查：curl http://127.0.0.1:3000/health"
}

upgrade_bot() {
  command -v git >/dev/null || die "未找到 Git，请先安装。"
  if [[ "${ANEKO_UPGRADE_HANDOFF:-0}" == 1 ]]; then
    unset ANEKO_UPGRADE_HANDOFF
  else
    upgrade_project
    local installed_script="${INSTALL_DIR}/deploy/install.sh"
    if [[ -f "${installed_script}" ]]; then
      log "部署脚本已更新，切换到最新版继续升级..."
      export ANEKO_UPGRADE_HANDOFF=1
      exec bash "${installed_script}" --upgrade
    fi
  fi
  ensure_user; chown -R "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}"; ensure_env
  if ! valid_env; then log "配置不完整，服务没有重启。"; return 0; fi
  install_unit; start_service; log "升级完成。"
}

config_bot() {
  [[ -d "${INSTALL_DIR}" ]] || die "尚未安装 ANeko-Bot。"
  ensure_user
  [[ -f "${INSTALL_DIR}/.env" ]] || cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
  configure_env 1
  ((CONFIG_CANCELLED)) && return 0
  chown "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}/.env"
  chmod 600 "${INSTALL_DIR}/.env"
  valid_env || { log "配置不完整，服务没有重启。"; return 0; }
  if has_service; then
    restart_service
  else
    log "配置已保存，服务尚未安装。"
  fi
}

status_bot() {
  has_service || die "服务尚未安装。"
  systemctl status "${SERVICE_NAME}" --no-pager || true
  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    printf '\n健康检查：\n'
    curl --fail --silent --show-error http://127.0.0.1:3000/health || true
    printf '\n'
  fi
}

uninstall_bot() {
  local answer home=""
  printf '输入 UNINSTALL 确认卸载：' > /dev/tty
  read -r answer < /dev/tty || true
  [[ "${answer}" == UNINSTALL ]] || { log "已取消卸载。"; return 0; }
  if id -u "${RUN_USER}" >/dev/null 2>&1; then home="$(getent passwd "${RUN_USER}" | cut -d: -f6)"; fi
  if has_service; then systemctl disable --now "${SERVICE_NAME}" || true; rm -f "/etc/systemd/system/${SERVICE_NAME}.service"; systemctl daemon-reload; fi
  [[ "${INSTALL_DIR}" != / && "${INSTALL_DIR}" != /opt ]] || die "拒绝删除危险目录。"
  rm -rf -- "${INSTALL_DIR}"
  [[ "${home}" == "${INSTALL_DIR}" ]] && userdel "${RUN_USER}" 2>/dev/null || true
  log "ANeko-Bot 已卸载。"
  return 10
}

pause_menu() { printf '\n按 Enter 返回菜单...' > /dev/tty; read -r < /dev/tty || true; }
run_menu_action() {
  local rc=0
  ("$1") || rc=$?
  ((rc == 10)) && return 10
  ((rc != 0)) && log "操作失败。"
  return 0
}

menu() {
  while true; do
    cat > /dev/tty <<'EOF'

========== ANeko-Bot 管理菜单 ==========
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
    local choice action rc
    printf '请选择 [0-7]: ' > /dev/tty
    read -r choice < /dev/tty || return 0
    case "${choice}" in
      1) action=install_bot ;; 2) action=upgrade_bot ;; 3) action=uninstall_bot ;;
      4) action=config_bot ;; 5) action=status_bot ;; 6) action=restart_service ;; 7) action=stop_service ;;
      0) return 0 ;; *) log "无效选项。"; pause_menu; continue ;;
    esac
    rc=0; run_menu_action "${action}" || rc=$?
    ((rc == 10)) && return 0
    pause_menu
  done
}

main() {
  root_check
  case "${1:-menu}" in
    menu|--menu) [[ -r /dev/tty ]] && menu || install_bot ;;
    install|--install) install_bot ;; upgrade|--upgrade) upgrade_bot ;;
    uninstall|--uninstall) uninstall_bot ;; config|--config) config_bot ;;
    status|--status) status_bot ;; restart|--restart) restart_service ;; stop|--stop) stop_service ;;
    *) die "未知参数：${1}。可用参数：--menu、--install、--upgrade、--uninstall、--config、--status、--restart、--stop。" ;;
  esac
}
main "$@"
