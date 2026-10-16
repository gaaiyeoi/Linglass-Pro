#!/bin/bash
# Linglass-Pro 一键安装（macOS 双击入口）
#
# 这个文件刻意很薄：真正的事情全在 tools/install.mjs 里，
# 与 Windows 侧的 install-windows.bat 共用同一份逻辑。
#
# 有 Node 就直接跑；没有就引导去装（扩展本身不需要 Node，只有安装程序需要）。

cd "$(dirname "$0")" || exit 1

echo ""
echo "Linglass-Pro 安装程序"
echo ""

if ! command -v node >/dev/null 2>&1; then
  cat <<'EOF'
还没有安装 Node.js。

它是这个安装程序跑起来需要的东西（扩展本身不需要它，装完就可以不管了）。
接下来会自动打开下载页面：下载 LTS 版本，一路「继续」装完，
然后回到这个文件夹，再双击一次本文件。

按任意键打开下载页面……
EOF
  read -n 1 -s -r
  open "https://nodejs.org/zh-cn/download"
  exit 1
fi

node tools/install.mjs
status=$?

echo ""
echo "（这个窗口可以关掉了。按任意键退出。）"
read -n 1 -s -r

exit $status
