#!/usr/bin/env node
/**
 * Discriminant-axis extraction verification (设计验证 · §6.1 第2步).
 *
 * 真实调用 LLM 路由（deepseek-v4-flash），对簇 10（31 条成员的"认知插件开发"
 * 过宽簇）提炼判别轴，验证：
 *   1. LLM 能否识别簇内行为差异（轴提炼有效）
 *   2. 判别词是否真实来自成员文本（防幻觉）
 *   3. 新手/资深这类前提判别轴能否被提炼（exp_56/57 的解药）
 *
 * 用法：node colddomain-test/verify-axes.mjs
 * 依赖：data/.credentials.yaml 的 DEEPSEEK_API_KEY（走 dsh 的 credentials 解析）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 直接调用已实现的 proposeDiscriminantAxes（通过 tsx 运行 .ts 导入）
// 但 mjs 无法直接 import ts——改为内联复刻调用逻辑，或用 tsx。
// 这里用 tsx 跑一个 .mts 包装，复用包内真实函数。

console.log('此脚本通过 tsx 运行 typescript 包装，见 verify-axes.mts')
