// normalizeSchema 回归测试：夹具 = 俯2026-10-16 从三台真实 MCP 服务器抓取的工具入参 schema。
// 这里只验插件自己的契约（不依赖 DSH 内部）；DSH 自己的校验器/渲染器复核见 test/live-verify.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeSchema, DROP_STRUCTURE, DROP_VALUE, STRUCTURAL_SIBLINGS, SCHEMA_TYPES } from '../index.js'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/tool-schemas.json', import.meta.url), 'utf8'))
const REJECTED = new Set([...DROP_STRUCTURE, ...DROP_VALUE])
const STRUCTURAL = new Set(STRUCTURAL_SIBLINGS)

/** 深度遍历任意 schema 子树。 */
function walk(node, visit, path = '$') {
	if (Array.isArray(node)) {
		node.forEach((item, index) => walk(item, visit, `${path}[${index}]`))
		return
	}
	if (node === null || typeof node !== 'object') return
	visit(node, path)
	for (const key of Object.keys(node)) walk(node[key], visit, `${path}.${key}`)
}

/** Harness JSON-Schema 子集的形状要求（与 dsh-tools json-schema.js 对齐）。 */
function assertSupportedShape(schema, label) {
	walk(schema, (node, path) => {
		assert.ok(!Array.isArray(node.type), `${label}: ${path}.type 仍是 type 数组`)
		for (const key of Object.keys(node)) {
			assert.ok(!REJECTED.has(key), `${label}: ${path}.${key} 仍是子集不支持的关键字`)
		}
		if ('additionalProperties' in node) {
			assert.equal(typeof node.additionalProperties, 'boolean', `${label}: ${path}.additionalProperties 不是布尔`)
		}
		const hasTypeOrOneOf = typeof node.type === 'string' || node.oneOf !== undefined
		for (const key of Object.keys(node)) {
			if (STRUCTURAL.has(key)) assert.ok(hasTypeOrOneOf, `${label}: ${path}.${key} 缺 type/oneOf`)
		}
		if (Array.isArray(node.required) && node.required.length > 0) {
			assert.ok(node.properties && typeof node.properties === 'object', `${label}: ${path}.required 没有 properties`)
			for (const name of node.required) {
				assert.ok(name in node.properties, `${label}: ${path}.required 指向不存在的属性 ${name}`)
			}
		}
		if (node.oneOf !== undefined) {
			assert.ok(Array.isArray(node.oneOf) && node.oneOf.length >= 2, `${label}: ${path}.oneOf 分支少于 2`)
		}
		if (typeof node.type === 'string') {
			assert.ok(SCHEMA_TYPES.has(node.type), `${label}: ${path}.type 非法：${node.type}`)
		}
	})
}

test('夹具是真实服务器抓下来的，样本量足够', () => {
	assert.ok(fixtures.tools.length >= 100, `夹具只有 ${fixtures.tools.length} 个工具`)
})

test('全部夹具规范化后满足受支持形状，且幂等（二次规范化返回同一引用）', () => {
	for (const tool of fixtures.tools) {
		const label = `${tool.server}/${tool.name}`
		const once = normalizeSchema(tool.inputSchema)
		assertSupportedShape(once, label)
		assert.equal(normalizeSchema(once), once, `${label}: 规范化不幂等`)
	}
})

test('未发生改写的输入必须是本来就合规的（同一引用 = 插件没动它）', () => {
	for (const tool of fixtures.tools) {
		const out = normalizeSchema(tool.inputSchema)
		if (out === tool.inputSchema) assertSupportedShape(tool.inputSchema, `${tool.server}/${tool.name} (未改写)`)
	}
})

test('可空 type 数组 -> oneOf(string, null)，参数名保留', () => {
	const schema = fixtures.tools.find((t) => t.server === 'vs-mcp-ursa' && t.name === 'FindSymbols').inputSchema
	const out = normalizeSchema(schema)
	assert.equal(out.properties.symbolName.type, 'string')
	assert.deepEqual(out.properties.symbolKind.oneOf, [{ type: 'string' }, { type: 'null' }])
	assert.deepEqual(out.required, ['symbolName'])
})

test('anyOf 被删掉，但参数与描述还在', () => {
	const schema = fixtures.tools.find((t) => t.server === 'ida' && t.name === 'list_funcs').inputSchema
	const out = normalizeSchema(schema)
	assert.equal(out.properties.queries.anyOf, undefined)
	assert.equal(typeof out.properties.queries.description, 'string')
	assert.deepEqual(out.required, ['queries'])
})

test('合成用例：纯元信息、非布尔 additionalProperties、悬空 required', () => {
	const out = normalizeSchema({
		$schema: 'http://json-schema.org/draft-07/schema#',
		type: 'object',
		additionalProperties: { type: 'string' },
		properties: { a: { type: 'string' } },
		required: ['a', 'b'],
	})
	assert.equal(out.$schema, undefined)
	assert.equal(out.additionalProperties, undefined)
	assert.deepEqual(out.required, ['a'])
})

test('合成用例：没有 type/oneOf 的孤儿兄弟关键字被清掉', () => {
	const out = normalizeSchema({ properties: { a: { type: 'string' } }, anyOf: [{ type: 'string' }] })
	assert.equal(out.properties, undefined)
	assert.equal(out.anyOf, undefined)
})

test('合成用例：本来就合规的 schema 零改动（同一引用）', () => {
	const clean = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }
	assert.equal(normalizeSchema(clean), clean)
})

test('合成用例：不受支持的组合子/约束被删，形状与参数名保留', () => {
	const out = normalizeSchema({
		type: 'object',
		properties: { p: { type: 'string', pattern: '^a', format: 'uuid', minLength: 1 } },
		allOf: [{ required: ['p'] }],
	})
	assert.equal(out.properties.p.pattern, undefined)
	assert.equal(out.properties.p.format, undefined)
	assert.equal(out.properties.p.minLength, undefined)
	assert.equal(out.allOf, undefined)
	assert.equal(out.properties.p.type, 'string')
})
