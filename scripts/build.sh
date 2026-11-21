#!/usr/bin/env bash
# Build: 无编译依赖的产物装配。
#
# 为什么不是 tsc：本机 DSH 安装包剥离了 .d.ts，也没有可用的源码 checkout
# （DSH_CHECKOUT 指向的目录没有 packages/），tsc 无法为宿主模块做类型解析。
# 因此源码直接写可运行的 ESM + JSDoc，构建 = 语法校验 + 同步到 lib/。
#
# 若之后有了带 packages/ 的源码 checkout，只需把本脚本换成 tsc，
# src/ 的模块边界不用动。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Checking source syntax ==="
COUNT=0
while IFS= read -r file; do
  node --check "$file"
  COUNT=$((COUNT + 1))
done < <(find src -type f -name '*.js' | sort)

echo "=== Assembling lib/ ==="
rm -rf lib
mkdir -p lib
cp -r src/. lib/

node -e "const p=require('./package.json'); if(!p.main) throw new Error('package.json: main is required'); console.log('main =', p.main)"

echo "=== Build complete: $COUNT source files ==="
