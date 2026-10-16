// 可选复核：用 DSH 自己的 JSON-Schema 校验器与 PTC 类型渲染器验证修复效果（CI 不跑）。
// 用法：DSH_MODULES=<含 @deepseek-ai/dsh-tools 的 node_modules 目录> node test/live-verify.mjs
// 可选：MCP_ENDPOINTS=http://host:port/...,http://host2:port2/...
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { normalizeSchema } from '../index.js'

const NL = String.fromCharCode(10)
const modulesDir = process.env.DSH_MODULES
if (!modulesDir) {
	console.error('需要 DSH_MODULES=<含 @deepseek-ai/dsh-tools 的 node_modules 目录>')
	process.exit(2)
}
const require = createRequire(join(modulesDir, 'anchor.js'))
const toolsEntry = require.resolve('@deepseek-ai/dsh-tools')
const { assertSupportedJsonSchema, jsonSchemaToTs } = await import(pathToFileURL(toolsEntry).href)

const endpoints = (process.env.MCP_ENDPOINTS ?? 'http://localhost:3001/SDK/,http://127.0.0.1:13337/mcp,http://127.0.0.1:13339/')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean)

const supported = (schema) => {
	try { assertSupportedJsonSchema(schema); return true } catch { return false }
}
const rendersUnknown = (schema) => jsonSchemaToTs(schema).trim() === 'unknown'

async function listTools(url) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
	})
	const text = await res.text()
	const line = text.split(NL).find((l) => l.trim().startsWith('data:'))
	const json = line ? JSON.parse(line.trim().slice(5)) : JSON.parse(text)
	return json.result?.tools ?? []
}

let total = 0, badBefore = 0, badAfter = 0, unknownBefore = 0, unknownAfter = 0
const fixed = []
const still = []
for (const url of endpoints) {
	let list
	try { list = await listTools(url) } catch (error) { console.error('跳过 ' + url + '：' + error.message); continue }
	for (const tool of list) {
		total++
		const before = tool.inputSchema ?? {}
		const after = normalizeSchema(before)
		if (!supported(before)) badBefore++
		if (!supported(after)) { badAfter++; still.push(url + '#' + tool.name) }
		if (rendersUnknown(before)) unknownBefore++
		if (rendersUnknown(after)) unknownAfter++
		if (rendersUnknown(before) && !rendersUnknown(after)) fixed.push(url + '#' + tool.name)
	}
}
console.log(JSON.stringify({ endpoints: endpoints.length, total, badBefore, badAfter, unknownBefore, unknownAfter, fixedCount: fixed.length }, null, 1))
if (still.length > 0) console.log('仍未通过（' + still.length + '）：' + NL + '  ' + still.join(NL + '  '))

for (const url of endpoints) {
	let list
	try { list = await listTools(url) } catch { continue }
	const tool = list.find((t) => t.name === 'FindSymbols')
	if (tool) console.log(NL + url + '#FindSymbols 规范化后的参数签名:' + NL + jsonSchemaToTs(normalizeSchema(tool.inputSchema)))
}
process.exitCode = still.length > 0 ? 1 : 0
