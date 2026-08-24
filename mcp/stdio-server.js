'use strict';

/**
 * Minimal MCP stdio transport for UCN's one-tool, local-only server.
 *
 * UCN does not expose HTTP, OAuth, resources, prompts, sampling, or remote
 * transports. Pulling those facilities into every npm install substantially
 * widened the production dependency and capability surface. This adapter
 * implements the MCP base lifecycle plus tools/list, tools/call, and ping over
 * newline-delimited JSON-RPC, which is the complete surface UCN advertises.
 */

const MAX_MESSAGE_CHARS = 10 * 1024 * 1024;
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
    '2024-11-05',
    '2025-03-26',
    '2025-06-18',
    LATEST_PROTOCOL_VERSION,
]);

const ERROR = Object.freeze({
    PARSE: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL: -32603,
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRequestId(value) {
    return value === null || typeof value === 'string' ||
        (typeof value === 'number' && Number.isFinite(value));
}

function toolError(message) {
    return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
    };
}

function validateValue(key, value, rule) {
    if (rule.type === 'string' && typeof value !== 'string') {
        return `${key} must be a string.`;
    }
    if (rule.type === 'boolean' && typeof value !== 'boolean') {
        return `${key} must be a boolean.`;
    }
    if (rule.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
        return `${key} must be a finite number.`;
    }
    if (rule.type === 'integer' &&
        (typeof value !== 'number' || !Number.isSafeInteger(value))) {
        return `${key} must be an integer.`;
    }
    if (rule.minLength !== undefined && value.length < rule.minLength) {
        return `${key} must contain at least ${rule.minLength} character(s).`;
    }
    if (rule.minimum !== undefined && value < rule.minimum) {
        return `${key} must be greater than or equal to ${rule.minimum}.`;
    }
    if (rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum) {
        return `${key} must be greater than ${rule.exclusiveMinimum}.`;
    }
    if (rule.maximum !== undefined && value > rule.maximum) {
        return `${key} must be less than or equal to ${rule.maximum}.`;
    }
    if (rule.enum && key !== 'command' && !rule.enum.includes(value)) {
        return `${key} must be one of: ${rule.enum.join(', ')}.`;
    }
    return null;
}

/**
 * Validate advertised input constraints without silently stripping unknown
 * keys. Unknown keys deliberately reach UCN's handler, which returns typo and
 * applicability guidance to the agent. The command enum is advertised for
 * discovery but runtime validation remains string-based so retired command
 * names can receive directive migration guidance.
 */
function validateToolArguments(value, schema) {
    if (!isObject(value)) return 'arguments must be an object.';
    for (const key of schema.required || []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            return `${key} is required.`;
        }
    }
    if (typeof value.project_dir === 'string' && value.project_dir.trim().length === 0) {
        return 'project_dir is required and must be a non-empty path.';
    }
    for (const [key, input] of Object.entries(value)) {
        const rule = schema.properties?.[key];
        if (!rule) continue;
        const error = validateValue(key, input, rule);
        if (error) return error;
    }
    return null;
}

class StdioMcpServer {
    constructor(serverInfo) {
        this.serverInfo = { ...serverInfo };
        this.tools = new Map();
        this.initialized = false;
        this.inputBuffer = '';
        this.discardOversizedLine = false;
    }

    registerTool(name, definition, handler) {
        if (this.tools.has(name)) throw new Error(`Tool already registered: ${name}`);
        this.tools.set(name, {
            definition: {
                name,
                description: definition.description,
                inputSchema: definition.inputSchema,
                annotations: definition.annotations,
                execution: { taskSupport: 'forbidden' },
            },
            handler,
        });
    }

    connect() {
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => this._receive(chunk));
        process.stdin.on('end', () => {
            if (this.inputBuffer.trim()) this._consumeLine(this.inputBuffer);
            this.inputBuffer = '';
        });
        process.stdin.resume();
    }

    _receive(chunk) {
        let remaining = chunk;
        while (remaining.length > 0) {
            const newline = remaining.indexOf('\n');
            const part = newline === -1 ? remaining : remaining.slice(0, newline);
            remaining = newline === -1 ? '' : remaining.slice(newline + 1);

            if (!this.discardOversizedLine) {
                this.inputBuffer += part;
                if (this.inputBuffer.length > MAX_MESSAGE_CHARS) {
                    this.inputBuffer = '';
                    this.discardOversizedLine = true;
                    this._sendError(null, ERROR.INVALID_REQUEST,
                        `MCP message exceeds ${MAX_MESSAGE_CHARS} characters.`);
                }
            }
            if (newline !== -1) {
                if (!this.discardOversizedLine) this._consumeLine(this.inputBuffer);
                this.inputBuffer = '';
                this.discardOversizedLine = false;
            }
        }
    }

    _consumeLine(rawLine) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line.trim()) return;
        let message;
        try {
            message = JSON.parse(line);
        } catch (_) {
            this._sendError(null, ERROR.PARSE, 'Parse error');
            return;
        }
        void this._handleMessage(message);
    }

    async _handleMessage(message) {
        if (!isObject(message) || message.jsonrpc !== '2.0' ||
            typeof message.method !== 'string') {
            const id = isObject(message) && isRequestId(message.id)
                ? message.id : null;
            this._sendError(id, ERROR.INVALID_REQUEST, 'Invalid Request');
            return;
        }

        const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
        if (hasId && !isRequestId(message.id)) {
            this._sendError(null, ERROR.INVALID_REQUEST, 'Invalid Request');
            return;
        }
        const isRequest = hasId;
        if (!isRequest) {
            if (message.method === 'notifications/initialized') this.initialized = true;
            // Cancellation may be ignored when synchronous work cannot be
            // interrupted; unknown notifications are also fire-and-forget.
            return;
        }

        try {
            switch (message.method) {
            case 'initialize':
                this._initialize(message.id, message.params);
                return;
            case 'ping':
                this._sendResult(message.id, {});
                return;
            case 'tools/list':
                this._listTools(message.id, message.params);
                return;
            case 'tools/call':
                await this._callTool(message.id, message.params);
                return;
            default:
                this._sendError(message.id, ERROR.METHOD_NOT_FOUND,
                    `Method not found: ${message.method}`);
            }
        } catch (error) {
            this._sendError(message.id, ERROR.INTERNAL,
                error?.message || 'Internal error');
        }
    }

    _initialize(id, params) {
        if (!isObject(params) || typeof params.protocolVersion !== 'string' ||
            !isObject(params.capabilities) || !isObject(params.clientInfo) ||
            typeof params.clientInfo.name !== 'string' ||
            typeof params.clientInfo.version !== 'string') {
            this._sendError(id, ERROR.INVALID_PARAMS, 'Invalid initialize parameters.');
            return;
        }
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(params.protocolVersion)
            ? params.protocolVersion : LATEST_PROTOCOL_VERSION;
        this._sendResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: this.serverInfo,
        });
    }

    _listTools(id, params) {
        if (params !== undefined && !isObject(params)) {
            this._sendError(id, ERROR.INVALID_PARAMS, 'tools/list params must be an object.');
            return;
        }
        if (params?.cursor !== undefined) {
            this._sendError(id, ERROR.INVALID_PARAMS,
                'Invalid tools/list cursor: UCN exposes one deterministic page.');
            return;
        }
        this._sendResult(id, {
            tools: [...this.tools.values()].map(tool => tool.definition),
        });
    }

    async _callTool(id, params) {
        if (!isObject(params) || typeof params.name !== 'string') {
            this._sendError(id, ERROR.INVALID_PARAMS,
                'tools/call requires a string name and object arguments.');
            return;
        }
        const tool = this.tools.get(params.name);
        if (!tool) {
            this._sendError(id, ERROR.INVALID_PARAMS, `Unknown tool: ${params.name}`);
            return;
        }
        const validationError = validateToolArguments(params.arguments, tool.definition.inputSchema);
        if (validationError) {
            this._sendResult(id, toolError(`Input validation error: ${validationError}`));
            return;
        }
        try {
            const result = await tool.handler(params.arguments);
            this._sendResult(id, result);
        } catch (error) {
            this._sendResult(id, toolError(error?.message || 'Tool execution failed.'));
        }
    }

    _sendResult(id, result) {
        this._write({ jsonrpc: '2.0', id, result });
    }

    _sendError(id, code, message) {
        this._write({ jsonrpc: '2.0', id, error: { code, message } });
    }

    _write(message) {
        process.stdout.write(`${JSON.stringify(message)}\n`);
    }
}

module.exports = {
    ERROR,
    LATEST_PROTOCOL_VERSION,
    MAX_MESSAGE_CHARS,
    StdioMcpServer,
    SUPPORTED_PROTOCOL_VERSIONS,
    validateToolArguments,
};
