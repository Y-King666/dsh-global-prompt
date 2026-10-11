/**
 * Global prompt (宿主半边).
 *
 * 作用域只有一件事：把用户级全局提示词文件（`$DSH_HOME/AGENTS.md`，本机即
 * `C:\Users\zhang\.dsh\AGENTS.md`）暴露给设置页，并提供读写它的 HTTP 路由。
 *
 * 为什么不需要自己写“注入”：
 *   `@deepseek-ai/dsh-agent-instructions`（由 dsh-base 默认启用）在会话开始时会读取
 *   `join(config.dshHome, "AGENTS.md")` 这一用户级全局文件，包成 <system-reminder>
 *   注入 Agent 上下文，并在每一步通过 reconcileInstructionContext 比对版本。所以
 *   只要把内容写进那个文件，就等于使用官方既有的全局提示词注入技术。
 *
 * 依赖约束：本插件位于 profile 的 node_modules 中，那里没有 `@deepseek-ai/*` 作用域目录，
 * 因此这里只允许 import Node 内置模块。
 *
 * @module dsh-global-prompt
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Cordis 服务名。 */
export const name = 'globalPrompt'

/** 只依赖 webServer：路由是客户端与宿主之间唯一的通道。 */
export const inject = ['webServer']

/** 路由路径（精确匹配）。 */
const ROUTE_PATH = '/global-prompt/api'

/** 用户级全局提示词文件名，由 dsh-agent-instructions 读取。 */
const PROMPT_FILE_NAME = 'AGENTS.md'

/** 请求体上限 1 MiB。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 与 dsh-base 中 agent-instructions 的 maxBytes 一致，超过时提示用户可能被截断。 */
const INSTRUCTION_BUDGET_BYTES = 65536

/**
 * 复刻 `@deepseek-ai/dsh-home-paths` 的 resolveDshHome：`$DSH_HOME`（去空白后非空）优先，
 * 否则 `~/.dsh`，最后解析为绝对路径。
 *
 * @returns {string} DSH home 的绝对路径。
 */
function resolveDshHome() {
	const configured = process.env.DSH_HOME
	const home = configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
	return resolve(home)
}

/**
 * `~/.dsh` 风格的可读展示路径，供界面显示。
 *
 * @param {string} home - resolveDshHome() 的结果。
 * @returns {string} 展示用路径前缀。
 */
function dshHomeDisplay(home) {
	return home === resolve(join(homedir(), '.dsh')) ? '~/.dsh' : '$DSH_HOME'
}

/**
 * 全局提示词文件的绝对路径。
 *
 * @returns {string} `$DSH_HOME/AGENTS.md` 的绝对路径。
 */
function promptFilePath() {
	return join(resolveDshHome(), PROMPT_FILE_NAME)
}

/**
 * 读取当前全局提示词。
 *
 * @returns {{exists: boolean, content: string, bytes: number, mtimeMs: number|null}} 快照。
 */
function readPrompt() {
	const path = promptFilePath()
	if (!existsSync(path)) return { exists: false, content: '', bytes: 0, mtimeMs: null }
	const content = readFileSync(path, 'utf8')
	return {
		exists: true,
		content,
		bytes: Buffer.byteLength(content, 'utf8'),
		mtimeMs: statSync(path).mtimeMs ?? null,
	}
}

/**
 * 写入全局提示词：先写同目录临时文件再原子替换，避免半截文件被 Agent 读到。
 * Windows 上 rename 覆盖偶发失败（杀软/索引占用）时退回直接写。
 *
 * @param {string} content - 新的文件内容。
 * @returns {{exists: boolean, content: string, bytes: number, mtimeMs: number|null}} 写入后的快照。
 */
function writePrompt(content) {
	const path = promptFilePath()
	mkdirSync(dirname(path), { recursive: true })
	const temporary = `${path}.${process.pid}.tmp`
	writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o644 })
	try {
		renameSync(temporary, path)
	} catch (error) {
		rmSync(temporary, { force: true })
		writeFileSync(path, content, { encoding: 'utf8', mode: 0o644 })
	}
	return readPrompt()
}

/**
 * 读取单个请求头（Node 会把重复头折叠成数组）。
 *
 * @param {import('node:http').IncomingHttpHeaders} headers - 请求头。
 * @param {string} key - 头名（小写）。
 * @returns {string|undefined} 头值。
 */
function headerOf(headers, key) {
	const value = headers[key]
	if (Array.isArray(value)) return value[0]
	return typeof value === 'string' ? value : undefined
}

/**
 * 把 `host[:port]` 解析成 URL 以便比较 hostname/host。
 *
 * @param {string} raw - 原始 authority。
 * @returns {URL|undefined} 解析结果。
 */
function parseAuthority(raw) {
	try {
		return new URL(`http://${raw}`)
	} catch {
		return undefined
	}
}

/**
 * 判断 hostname 是否为回环地址。
 *
 * @param {string} hostname - URL hostname。
 * @returns {boolean} 是否回环。
 */
function isLoopbackHostname(hostname) {
	const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
	return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
}

/**
 * 与 dsh-mcp-connector 同款的信任校验：webServer 的普通路由不经过 connection 层的
 * token 鉴权，所以每个路由必须自己确认请求来自本机同源页面。
 *
 * @param {import('node:http').IncomingMessage} request - 请求。
 * @param {string[]} trustedHosts - `webRuntime.trustedHosts`。
 * @returns {boolean} 是否可信。
 */
function isTrustedWebRequest(request, trustedHosts) {
	const host = headerOf(request.headers, 'host')
	if (host === undefined) return false
	const hostUrl = parseAuthority(host)
	if (hostUrl === undefined) return false
	if (!isLoopbackHostname(hostUrl.hostname)) {
		let matched = false
		for (const raw of trustedHosts ?? []) {
			const authority = typeof raw === 'string' ? parseAuthority(raw) : undefined
			if (authority !== undefined && authority.host === hostUrl.host) {
				matched = true
				break
			}
		}
		if (!matched) return false
	}
	if (headerOf(request.headers, 'sec-fetch-site') === 'cross-site') return false
	const origin = headerOf(request.headers, 'origin')
	if (origin === undefined) return true
	try {
		return new URL(origin).host === hostUrl.host
	} catch {
		return false
	}
}

/**
 * 写 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} response - 响应。
 * @param {number} status - HTTP 状态码。
 * @param {object} payload - JSON 载荷。
 * @returns {void}
 */
function sendJson(response, status, payload) {
	const body = JSON.stringify(payload)
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body, 'utf8'),
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	})
	response.end(body)
}

/**
 * 收集并解析 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} request - 请求。
 * @param {number} limit - 字节上限。
 * @returns {Promise<object>} 解析后的 JSON 对象。
 */
async function readJsonBody(request, limit) {
	const chunks = []
	let size = 0
	for await (const chunk of request) {
		size += chunk.length
		if (size > limit) {
			const error = new Error(`request body exceeds ${limit} bytes`)
			error.statusCode = 413
			throw error
		}
		chunks.push(chunk)
	}
	if (size === 0) return {}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} catch {
		const error = new Error('request body is not valid JSON')
		error.statusCode = 400
		throw error
	}
}

/**
 * 组装 API 响应：文件快照 + 路由元信息。
 *
 * @param {{exists: boolean, content: string, bytes: number, mtimeMs: number|null}} snapshot - 文件快照。
 * @returns {object} 响应载荷。
 */
function payloadOf(snapshot) {
	const home = resolveDshHome()
	return {
		ok: true,
		exists: snapshot.exists,
		content: snapshot.content,
		bytes: snapshot.bytes,
		mtimeMs: snapshot.mtimeMs,
		path: promptFilePath(),
		displayPath: `${dshHomeDisplay(home)}/${PROMPT_FILE_NAME}`,
		budgetBytes: INSTRUCTION_BUDGET_BYTES,
		limitBytes: MAX_BODY_BYTES,
	}
}

/**
 * 注册 `/global-prompt/api`：GET 读取当前内容，POST 覆盖写入。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
	const dispose = ctx.webServer.register({
		kind: 'exact',
		path: ROUTE_PATH,
		handler: async (request, response) => {
			const webRuntime = typeof ctx.get === 'function' ? ctx.get('webRuntime') : ctx.webRuntime
			if (!isTrustedWebRequest(request, webRuntime?.trustedHosts ?? [])) {
				sendJson(response, 403, { ok: false, error: 'forbidden' })
				return
			}
			try {
				if (request.method === 'GET' || request.method === 'HEAD') {
					sendJson(response, 200, payloadOf(readPrompt()))
					return
				}
				if (request.method !== 'POST') {
					response.writeHead(405, { allow: 'GET, POST' })
					response.end()
					return
				}
				const body = await readJsonBody(request, MAX_BODY_BYTES)
				if (typeof body.content !== 'string') {
					sendJson(response, 400, { ok: false, error: 'body.content must be a string' })
					return
				}
				if (Buffer.byteLength(body.content, 'utf8') > MAX_BODY_BYTES) {
					sendJson(response, 413, { ok: false, error: `content exceeds ${MAX_BODY_BYTES} bytes` })
					return
				}
				sendJson(response, 200, payloadOf(writePrompt(body.content)))
			} catch (error) {
				const status = typeof error?.statusCode === 'number' ? error.statusCode : 500
				if (status >= 500) ctx.logger?.warn?.(`global-prompt: ${error?.stack ?? error}`)
				sendJson(response, status, { ok: false, error: error?.message ?? String(error) })
			}
		},
	})
	ctx.effect(() => dispose, 'global-prompt:api-route')
}
