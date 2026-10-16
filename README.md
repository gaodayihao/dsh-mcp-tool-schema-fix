# dsh-mcp-tool-schema-fix

让 MCP 工具的**参数名**在 DSH 的 PTC 模式下不再消失。

## 它解决什么

PTC 模式下调 MCP 工具，agent 常常要试两次才调对：

`@jsonc
// 第一次：猜的
{ "pattern": "PlayerRuntime" }            // -> Error: An error occurred invoking 'FindSymbols'.
// 第二次：才知道真名
{ "symbolName": "BuffApply" }
`@

原因不是 agent 笨，是**参数名根本没进提示**：

1. DSH 的 JSON-Schema 子集只接受单字符串 `type`（`dsh-tools/lib/types/json-schema.js` 明确把 type 数组判为不支持）。
   MCP 服务端把可空参数写成 `"type": ["string","null"]`、把多形态参数写成 `anyOf`，`jsonSchemaToTs()` 于是对
   **整个工具**回退成 `unknown` —— 连必备参数名都不剩。
2. MCP 服务端把入参校验错误吞成一句 `An error occurred invoking '<Tool>'.`，猜错了没有可读信号。

## 它怎么做

MCP 工具一律经 `ctx.tools.register(definition)` 注册（`dsh-mcp-client` 的 `syncTools`），
`definition.parameters` 就是服务端 inputSchema，而 `register` 只断言 `output.schema`、不碰 `parameters`。
本插件只包住这一个方法，注册前把 `parameters` 改写进受支持的子集。

| 输入形态 | 处理 | 结果 |
|---|---|---|
| `"type": ["string","null"]` | 改写成 `oneOf: [{type:"string"},{type:"null"}]` | 渲染成 `string \| null`，参数名与可空性都保住 |
| `anyOf` / `allOf` / `not` / `\$ref` / `if`…`else` / `dependentSchemas` | 删关键字 | 参数仍在，类型退化为 `JsonValue` |
| 值级约束 `format` / `pattern` / `minimum` / `maxLength` / `uniqueItems` / `patternProperties` … | 删关键字 | 只丢 Harness 表达不了的校验强度 |
| 非布尔 `additionalProperties` | 删 | 缺省 = 开放，同效 |
| 悬空 `required`、缺 type/oneOf 时的孤儿兄弟关键字 | 删 | 否则整份 schema 被 Reject |
| 纯元信息 `\$schema` / `\$id` / `\$defs` … | 删 | 不改语义 |

**安全口径：只放宽、绝不收紧。**

- 为什么**不**把 `anyOf` 转成 `oneOf`：`anyOf` = 至少匹配一个，`oneOf` = 恰好一个。硬转会把**合法调用**判成
  `INVALID_ARGS`，比看不到参数名更糟。删关键字只让 Harness 侧校验变松，而服务端始终校验自己的入参。
- 本来就是正常形状的 schema，`normalizeSchema` 返回**同一引用**，插件原样透传 —— 对它们零影响。
- 零静态 import；`register` / `ctx.effect` 缺失或改写抛错时只 warn 并放行原始定义 ——
  插件失效可以接受，让工具注册失败不可以。

## 实测

用 DSH 自己的 `assertSupportedJsonSchema` + `jsonSchemaToTs` 复核（三台真实 MCP 服务器，共 179 个工具）：

| 指标 | 修前 | 修后 |
|---|---|---|
| schema 不受支持（⇒ 声明为 `unknown`） | 85 | **0** |
| 被修复的工具 | — | **85** |
| 原样透传（同一引用） | — | 89 |

`FindSymbols` 修前 / 修后：

`@ts
unknown                                   // 修前

{                                         // 修后
  symbolName: string;
  symbolKind?: string | null;
  pathFormat?: string; outputFormat?: string; limit?: number; offset?: number;
} & Record<string, JsonValue>
`@

本仓 `test/fixtures/tool-schemas.json` 存了这 179 个真实 schema，`npm test` 每次都会重跑契约断言。

## 安装（GitHub）

`@bash
# 1) 把依赖装进目标 profile（pnpm 直连 GitHub）
dsh plugin --profile desktop add github:<you>/dsh-mcp-tool-schema-fix

# 2) 让 profile 加载它的 bundle patch：把 "dsh-mcp-tool-schema-fix" 追加进该 profile
#    package.json 的 dsh.profile.bundles，或在桌面应用的 Plugin Manager 里启用
#    （plugin_manager 的 install_bundle 会同时做这两步）。

# 3) 重启 DSH —— profile 层在启动时挂载，改完必须重启。
`@

> `desktop` profile 由桌面应用独占，`dsh --profile desktop` 不能 boot/dump 它；
> `dsh plugin add` 只加依赖，**不会**自动进 `dsh.profile.bundles`。

## 验证已生效

重启后新开一个会话，问 agent「`mcp__vs-mcp-ursa__FindSymbols` 的入参类型是什么」——
应该是 `{ symbolName: string; … }` 而不是 `unknown`；或直接让它按符号名查找，第一次就该传 `symbolName`。

## 回滚

从 `dsh.profile.bundles` 删掉包名（或在 Plugin Manager 里禁用），
`dsh plugin --profile <name> remove dsh-mcp-tool-schema-fix`，重启。

## 开发

`@bash
npm test    # 9 个契约测试，不需要 DSH，也不需要 MCP 服务

# 可选：用 DSH 自己的校验器 / 渲染器复核（需要 MCP 服务在跑）
DSH_MODULES=<含 @deepseek-ai/dsh-tools 的 node_modules 目录> node tools/live-verify.mjs
`@

`DSH_MODULES` 可以是任意一份含 `node_modules/@deepseek-ai/dsh-tools` 的目录：DSH 源码 checkout 的
`node_modules`，或从 `app.asar` 解出来的依赖树。

## 兼容性

- 依赖两个上游契约：`ctx.tools.register(definition)` 与 `definition.parameters` 承载入参 schema；以及
  `dsh-tools` 的 JSON-Schema 子集。
- DSH 日后若放宽子集，本插件自动退化为**无操作**（schema 不变时原样透传）；若 `register` 契约变了，
  插件只 warn 并停止介入，不影响工具注册。
- 日志前缀 `mcp-tool-schema-fix:`（挂载一条 info，每个被改写的工具一条 debug，异常一条 warn）。

## 许可

MIT（见 `LICENSE`；把版权行换成你自己的名字即可）。
