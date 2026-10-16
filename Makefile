# Linglass-Pro —— 常用命令
#
# 首次使用：
#   make build        构建 dist/
#   make open         打开 Arc 扩展管理页，手动「加载已解压的扩展程序」选 dist/
#
# 之后日常：
#   make dev          改代码自动重建 + 自动重载，不用手点刷新
#
# 官方发新版：
#   make vendor-update
#
# 要把扩展装给不懂命令行的人（见 docs/plans/023-one-click-installer.md）：
#   make package      产出 release/Linglass-Pro-<版本>-installer.zip

SHELL    := /bin/bash
DIST     := dist

.DEFAULT_GOAL := help

.PHONY: help build test probe dev open package check vendor-update vendor-from clean

help:
	@echo "make build                        构建 dist/（正式版）"
	@echo "make test                         跑契约测试与逻辑冒烟测试"
	@echo "make probe                        开一个带扩展的浏览器实测（弹窗，跑完保留窗口）"
	@echo "make dev                          监听 src/ 自动重建 + 自动重载（开发用）"
	@echo "make open                         打开已装浏览器的扩展管理页"
	@echo "make package                      打「一键安装包」到 release/"
	@echo "make check                        检查 dist/ 是否已正确注入 mod 脚本"
	@echo "make vendor-update                从 Chrome 商店拉取官方最新版作为基线"
	@echo "make vendor-from FROM=~/ll.crx    从本地 crx / zip / 解压目录导入基线"

build:
	node build.mjs

# 只用 node:test，无第三方依赖。契约测试要读 vendor/，所以先跑 make vendor-update。
test:
	node --test tools/test/*.test.mjs

# 实测探针：需要能加载扩展的浏览器（Chrome for Testing）。
# 想指定视频就用 node tools/probe.mjs --headed --url=<地址>。
probe:
	node tools/probe.mjs --headed --keep

dev:
	node tools/dev.mjs

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
	echo "没找到 Chrome / Arc / Edge / Brave，请手动打开扩展管理页（chrome://extensions）"
	@echo "→ 开发者模式 → 加载已解压的扩展程序 → 选 $$(pwd)/$(DIST)"

# 一键安装包：只装我们自己的东西；官方基线由用户本机安装时自己拉（合规红线见 PLAN 023）
package: build
	@node tools/package.mjs

check:
	@test -f "$(DIST)/manifest.json" || (echo "dist/ 不存在，先跑 make build"; exit 1)
	@test ! -d "$(DIST)/_metadata" || (echo "dist/_metadata 还在（加载会报错），重跑 make build"; exit 1)
	@node -e "const m=require('./$(DIST)/manifest.json');const mods=m.content_scripts.flatMap(c=>(c.js||[]).filter(j=>j.startsWith('mod/')));if(!mods.length){console.error('没有注入任何 mod 脚本');process.exit(1)}console.log('版本    '+m.version);console.log('已注入  '+mods.join(', '))"

vendor-update:
	node tools/import-vendor.mjs --download && node build.mjs

vendor-from:
	@test -n "$(FROM)" || (echo "用法: make vendor-from FROM=~/ll.crx"; exit 1)
	node tools/import-vendor.mjs --from "$(FROM)" && node build.mjs

clean:
	rm -rf "$(DIST)"
	@echo "已删除 $(DIST)/"
