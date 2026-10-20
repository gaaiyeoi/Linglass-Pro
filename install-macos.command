#!/bin/bash
# Linglass-Pro 安装入口（macOS）
#
# 实际安装逻辑位于 tools/install.mjs，与 install-windows.bat 共用。

cd "$(dirname "$0")" || exit 1

echo ""
echo "Linglass-Pro 安装程序"
echo ""

if ! command -v node >/dev/null 2>&1; then
  cat <<'EOF'
未检测到 Node.js。

安装脚本需要 Node.js，扩展运行时不依赖它。
按任意键将打开下载页面，请安装 LTS 版本，然后重新运行本文件。

按任意键继续……
EOF
  read -n 1 -s -r
  open "https://nodejs.org/zh-cn/download"
  exit 1
fi

node tools/install.mjs
status=$?

echo ""
echo "安装流程结束，可以关闭此窗口。按任意键退出。"
read -n 1 -s -r

exit $status
