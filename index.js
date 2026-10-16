/**
 * dsh-mcp-tool-schema-fix —— 让 MCP 工具的参数名在 DSH 的 PTC 模式下不再消失。
 *
 * ## 症状
 * PTC 模式下第一次调 `mcp__vs-mcp-ursa__FindSymbols` 往往要走两步：
 *   1. `{ "pattern": "PlayerRuntime" }` -> `Error: An error occurred invoking 'FindSymbols'.`
 *   2. 翻一遍才知道真名是 `symbolName`（正确调用返回 `{"totalCount":1,...}`）。
 * 报错里没有任何参数信息，等于每次多烧一次工具调用。
 *
 * ## 根因（两层）
 * 1. DSH 的 JSON-Schema 子集只接受**单字符串** `type`（`dsh-tools/lib/types/json-schema.js` 明确把
 *    type 数组判为不支持）。MCP 服务端把可空参数写成 `"type": ["string","null"]`、把多形态参数写成
 *    `anyOf`，于是 `jsonSchemaToTs()` 对**整个工具**回退成 `unknown`：模型连必备参数名都看不到。
 * 2. MCP 服务端把入参校验错误吞成一句话，猜错没有可读信号纠正。
 *
 * ## 接缝
 * MCP 工具一律经 `ctx.tools.register(definition)` 注册（dsh-mcp-client 的 `syncTools`），其中
 * `parameters` 就是服务端 inputSchema，而 `register` 只断言 `output.schema`、**不碰 parameters**。
 * 本插件只包住这一个方法，注册前把 `parameters` 改写进受支持的子集。
 *
 * ## 改写规则（安全口径：只放宽、绝不收紧）
 * - `"type": ["string","null"]` -> `oneOf: [{type:"string"},{type:"null"}]`：两个 SDK 渲染器都会印成
 *   `string | null`，参数名与可空性都保住。
 * - 不受支持的组合子（`anyOf`/`allOf`/`not`/`$ref`/`if`/`then`/`else`/…）与值级约束
 *   （`format`/`pattern`/`minimum`/…）-> 删关键字、保参数名与描述。
 * - 非布尔 `additionalProperties`、悬空 `required`、缺 type/oneOf 时的孤儿兄弟关键字 -> 删。
 *
 * **为什么不把 anyOf 转成 oneOf**：`anyOf` = 至少匹配一个，`oneOf` = 恰好一个。硬转会把**合法调用**
 * 判成 `INVALID_ARGS` —— 那比看不到参数名更糟。删关键字只会让 Harness 侧校验变松，而服务端始终校验
 * 自己的入参，方向安全。
 *
 * 整棵树未发生变化时返回**同一引用**，插件原样透传（对本来就正常的工具零影响）。
 *
 * @module dsh-mcp-tool-schema-fix
 */

export const name = 'dsh-mcp-tool-schema-fix'

/** 注册时机依赖 tools 服务存在。 */
export const inject = ['tools']

/** JSON-Schema 标量类型全集（与 dsh-tools json-schema.js 的 SCHEMA_TYPES 一致）。 */
export const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'])

/** 没有 type/oneOf 就不许出现的兄弟关键字（与 dsh-tools json-schema.js 的 ONE_OF_SIBLING_KEYWORDS 一致）。 */
export const STRUCTURAL_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

/** 组合子与引用：子集不支持；删掉只会放宽（服务端照旧校验）。 */
export const DROP_STRUCTURE = ['anyOf', 'allOf', 'not', '$ref', '$recursiveRef', 'dependentSchemas', 'if', 'then', 'else']

/** 元信息与值级约束：删掉不改变参数形状，只丢 Harness 表达不了的校验强度。 */
export const DROP_VALUE = [
	'$schema', '$id', '$comment', 'id', '$defs', 'definitions',
	'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
	'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
	'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
	'propertyNames', 'patternProperties', 'contentMediaType', 'contentEncoding', 'contentSchema',
	'deprecated', 'readOnly', 'writeOnly',
]

const DROP_SET = new Set([...DROP_STRUCTURE, ...DROP_VALUE])

/**
 * 把一个 schema 节点改写进 Harness 受支持的子集。
 * @param value - 任意 schema 子树。
 * @returns 改写后的树；未发生改写时返回**同一引用**（调用方据此决定要不要动）。
 */
export function normalizeSchema(value) {
	if (Array.isArray(value)) {
		let changed = false
		const out = value.map((item) => {
			const next = normalizeSchema(item)
			if (next !== item) changed = true
			return next
		})
		return changed ? out : value
	}
	if (value === null || typeof value !== 'object') return value

	let changed = false
	const out = {}
	for (const key of Object.keys(value)) {
		const next = normalizeSchema(value[key])
		if (next !== value[key]) changed = true
		out[key] = next
	}

	for (const key of DROP_SET) {
		if (key in out) {
			delete out[key]
			changed = true
		}
	}

	if (Array.isArray(out.type)) {
		const members = [...new Set(out.type.filter((t) => typeof t === 'string' && SCHEMA_TYPES.has(t)))]
		if (members.length === 1) {
			out.type = members[0]
		} else if (members.length === 0) {
			delete out.type
		} else if (STRUCTURAL_SIBLINGS.some((key) => key in out)) {
			// 不能升成 oneOf（并列关键字违规）=> 退到非 null 分支，至少保住参数名。
			out.type = members.find((t) => t !== 'null') ?? members[0]
		} else {
			delete out.type
			out.oneOf = members.map((t) => ({ type: t }))
		}
		changed = true
	}

	// Harness 只接受布尔 additionalProperties；缺省 = 开放，同效且不再整工具报废。
	if ('additionalProperties' in out && typeof out.additionalProperties !== 'boolean') {
		delete out.additionalProperties
		changed = true
	}

	// 没有 type/oneOf 时，这些关键字本身就违规（整节点报废）=> 一并删掉，退成只带描述的参数。
	if (out.type === undefined && out.oneOf === undefined) {
		for (const key of STRUCTURAL_SIBLINGS) {
			if (key in out) {
				delete out[key]
				changed = true
			}
		}
	}

	// required 指向不存在的属性会让整份 schema 被拒 => 删掉悬空项（服务端仍会校验必填）。
	if (Array.isArray(out.required)) {
		const properties = out.properties !== null && typeof out.properties === 'object' ? out.properties : undefined
		const dangling = out.required.some((key) => properties === undefined || !(key in properties))
		if (dangling) {
			const kept = properties === undefined ? [] : out.required.filter((key) => key in properties)
			if (kept.length > 0) out.required = kept
			else delete out.required
			changed = true
		}
	}

	return changed ? out : value
}

/**
 * 包住 `ctx.tools.register`，注册前规范化 `parameters`。
 *
 * 防御性：`register` 不存在、`ctx.effect` 不存在、改写抛错三种情况都只 warn 并放行原始定义 ——
 * 插件失效可以接受，让工具注册失败不可以。
 * @param ctx - 插件上下文（inject 保证 tools 存在）。
 */
export function apply(ctx) {
	const tools = ctx?.tools
	const original = tools?.register
	if (typeof original !== 'function') {
		ctx?.logger?.warn?.('mcp-tool-schema-fix: ctx.tools.register 不可用，插件不生效（DSH 版本可能已变）')
		return
	}
	if (typeof ctx.effect !== 'function') {
		ctx.logger?.warn?.('mcp-tool-schema-fix: ctx.effect 不可用，插件不生效（DSH 版本可能已变）')
		return
	}

	// 可选自检：能解析到 dsh-tools 就用它复核改写结果；解析不到就只做改写（不因此失败）。
	let verify = null
	import('@deepseek-ai/dsh-tools').then((mod) => {
		if (typeof mod?.assertSupportedJsonSchema === 'function') verify = mod.assertSupportedJsonSchema
	}).catch(() => {})

	ctx.effect(() => {
		const patched = function registerWithNormalizedSchema(definition) {
			let next = definition
			try {
				if (definition !== null && typeof definition === 'object' && definition.parameters !== undefined) {
					const parameters = normalizeSchema(definition.parameters)
					if (parameters !== definition.parameters) {
						if (verify !== null) {
							try {
								verify(parameters)
							} catch (error) {
								ctx.logger?.warn?.('mcp-tool-schema-fix: "' + definition.name + '" 改写后仍不在受支持子集内，原样注册：' + String(error))
								return original.call(this, definition)
							}
						}
						ctx.logger?.debug?.('mcp-tool-schema-fix: "' + definition.name + '" 参数 schema 已规范化')
						next = { ...definition, parameters }
					}
				}
			} catch (error) {
				ctx.logger?.warn?.('mcp-tool-schema-fix: 规范化 "' + definition?.name + '" 失败，原样注册：' + String(error))
				next = definition
			}
			return original.call(this, next)
		}
		tools.register = patched
		ctx.logger?.info?.('mcp-tool-schema-fix: 已挂载（MCP 工具入参 schema 规范化）')
		return () => {
			if (tools.register === patched) tools.register = original
		}
	}, 'mcp-tool-schema-fix')
}
