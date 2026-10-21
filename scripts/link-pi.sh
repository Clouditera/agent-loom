#!/usr/bin/env bash
# 把全局安装的 pi（≥1.2）链接进本包的 node_modules，免去 npm install。
# 用法：bash scripts/link-pi.sh
set -euo pipefail
cd "$(dirname "$0")/.."
G="$(npm root -g)"
PCA="$G/@earendil-works/pi-coding-agent"
[ -d "$PCA" ] || { echo "找不到全局 pi：$PCA（先 npm i -g @earendil-works/pi-coding-agent）"; exit 1; }
ver=$(node -p "require('$PCA/package.json').version")
echo "pi-coding-agent $ver"
mkdir -p node_modules/@earendil-works
ln -sfn "$PCA" node_modules/@earendil-works/pi-coding-agent
# 用 pi-coding-agent 自带的那份 pi-ai，保证只有一个实例
ln -sfn "$PCA/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
[ -d "$PCA/node_modules/@types" ] && ln -sfn "$PCA/node_modules/@types" node_modules/@types
echo "完成。node_modules/@earendil-works →"; ls -l node_modules/@earendil-works
