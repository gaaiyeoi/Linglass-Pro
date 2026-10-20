# Linglass-Pro 常用命令
#
# 首次使用：
#   make vendor-update   获取 Linglass 基线并构建
#   make open            打开扩展管理页，加载 dist/
#
# 日常开发：
#   make dev             监听源码变化，自动重建并重载扩展
#
# Linglass 发布新版本后：
#   make vendor-update

SHELL    := /bin/bash
DIST     := dist

.DEFAULT_GOAL := help

.PHONY: help build test probe dev cast cast-demo open package check vendor-update vendor-from clean

help:
	@echo "make build            构建 dist/"
	@echo "make test             运行契约测试与冒烟测试"
	@echo "make probe            启动带扩展的浏览器进行实测"
	@echo "make dev              监听源码，自动重建并重载扩展"
	@echo "make cast             启动手机字幕屏的局域网中转，默认端口 8899"
	@echo "make cast-demo        使用模拟字幕启动局域网中转"
	@echo "make open             打开扩展管理页"
	@echo "make package          生成发布包到 release/"
	@echo "make check            校验 dist/ 的注入结果"
	@echo "make vendor-update    从 Chrome 商店获取 Linglass 最新版本作为基线"
	@echo "make vendor-from      从本地 crx、zip 或解压目录导入基线：FROM=<路径>"

build:
	node build.mjs

# 测试使用 node --test，无第三方依赖。契约测试读取 vendor/，运行前需执行 make vendor-update。
test:
	node --test tools/test/*.test.mjs

# 实测脚本需要可加载扩展的 Chromium 浏览器；可用 --url 指定页面。
probe:
	node tools/probe.mjs --headed --keep

dev:
	node tools/dev.mjs

# 手机字幕屏的中转服务。手机与 Mac 需连接同一 Wi-Fi。
cast:
	node tools/cast-server.mjs

cast-demo:
	node tools/cast-server.mjs --demo

open:
	@for spec in "Google Chrome|chrome://extensions" "Arc|arc://extensions" \
	             "Microsoft Edge|chrome://extensions" "Brave Browser|chrome://extensions" \
	             "Chromium|chrome://extensions"; do \
	  app=$${spec%%|*}; url=$${spec##*|}; \
	  if [ -d "/Applications/$$app.app" ]; then \
	    open -a "$$app" "$$url" 2>/dev/null || open -a "$$app"; \
	    echo "已在 $$app 打开扩展管理页"; \
	    exit 0; \
	  fi; \
	done; \
	echo "未找到受支持的浏览器，请手动打开 chrome://extensions"
	@echo "启用开发者模式，选择「加载已解压的扩展程序」，选中 $$(pwd)/$(DIST)"

# 发布包只包含本项目源码、安装脚本与图文向导；安装时获取 Linglass 当前版本并合并。
package: build
	@node tools/package.mjs

check:
	@test -f "$(DIST)/manifest.json" || (echo "dist/ 不存在，请先运行 make build"; exit 1)
	@test ! -d "$(DIST)/_metadata" || (echo "dist/_metadata 仍然存在，请重新运行 make build"; exit 1)
	@node -e "const m=require('./$(DIST)/manifest.json');const mods=m.content_scripts.flatMap(c=>(c.js||[]).filter(j=>j.startsWith('mod/')));if(!mods.length){console.error('没有注入任何 mod 脚本');process.exit(1)}console.log('版本    '+m.version);console.log('已注入  '+mods.join(', '))"

vendor-update:
	node tools/import-vendor.mjs --download && node build.mjs

vendor-from:
	@test -n "$(FROM)" || (echo "用法：make vendor-from FROM=<crx、zip 或目录路径>"; exit 1)
	node tools/import-vendor.mjs --from "$(FROM)" && node build.mjs

clean:
	rm -rf "$(DIST)"
	@echo "已删除 $(DIST)/"
