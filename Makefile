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

SHELL    := /bin/bash
ARC_APP  := Arc
DIST     := dist

.DEFAULT_GOAL := help

.PHONY: help build test probe dev open check vendor-update vendor-from clean

help:
	@echo "make build                        构建 dist/（正式版）"
	@echo "make test                         跑契约测试与逻辑冒烟测试"
	@echo "make probe                        开一个带扩展的浏览器实测（弹窗，跑完保留窗口）"
	@echo "make dev                          监听 src/ 自动重建 + 自动重载（开发用）"
	@echo "make open                         打开 Arc 扩展管理页（arc://extensions）"
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
	@open -a "$(ARC_APP)" "arc://extensions" 2>/dev/null || open -a "$(ARC_APP)"
	@echo "→ 开发者模式 → 加载已解压的扩展程序 → 选 $$(pwd)/$(DIST)"

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
