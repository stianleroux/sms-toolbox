interface Env {
	SMS_KV: KVNamespace;
	SMS_QUEUE: Queue;
	API_KEY?: string;
}

type SmsJob = {
	id: string;
	deviceId: string;
	to: string;
	text: string;
	createdAt: string;
};

type InboxItem = {
	id: string;
};

type SmsStatus = "pending" | "sent" | "failed";

type SmsRecord = SmsJob & {
	status: SmsStatus;
	lastError?: string;
	sentAt?: string;
};

const jsonHeaders = {
	"content-type": "application/json; charset=utf-8",
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET,POST,OPTIONS",
	"access-control-allow-headers": "content-type,x-api-key",
};

const HARD_CODED_API_KEY = "sms-toolbox-2026-secret";

function response(status: number, body: unknown) {
	return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

async function readJson<T>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T;
	} catch {
		return null;
	}
}

function requireApiKey(request: Request, env: Env): boolean {
	// Uses env API_KEY when configured; otherwise falls back to a built-in key.
	const expectedApiKey = env.API_KEY?.trim() || HARD_CODED_API_KEY;
	const url = new URL(request.url);
	const headerApiKey = request.headers.get("x-api-key")?.trim() || "";
	const queryApiKey = url.searchParams.get("key")?.trim() || "";
	return headerApiKey === expectedApiKey || queryApiKey === expectedApiKey;
}

function validatePhone(value: string): boolean {
	// Basic E.164-ish validation.
	return /^\+?[1-9]\d{6,14}$/.test(value);
}

function makeId(): string {
	return crypto.randomUUID();
}

function inboxKey(deviceId: string): string {
	return `inbox:${deviceId}`;
}

function recordKey(id: string): string {
	return `msg:${id}`;
}

async function getInbox(env: Env, deviceId: string): Promise<InboxItem[]> {
	const raw = await env.SMS_KV.get(inboxKey(deviceId));
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as InboxItem[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

async function putInbox(env: Env, deviceId: string, items: InboxItem[]): Promise<void> {
	await env.SMS_KV.put(inboxKey(deviceId), JSON.stringify(items));
}

async function enqueueSms(env: Env, payload: { deviceId: string; to: string; text: string }) {
	const job: SmsJob = {
		id: makeId(),
		deviceId: payload.deviceId,
		to: payload.to,
		text: payload.text,
		createdAt: new Date().toISOString(),
	};

	await env.SMS_QUEUE.send(job);
	return job;
}

async function handleEnqueue(request: Request, env: Env): Promise<Response> {
	if (!requireApiKey(request, env)) {
		return response(401, { error: "unauthorized" });
	}

	const body = await readJson<{ deviceId?: string; to?: string; text?: string }>(request);
	if (!body?.deviceId || !body?.to || !body?.text) {
		return response(400, { error: "deviceId, to, text are required" });
	}

	if (!validatePhone(body.to)) {
		return response(400, { error: "invalid phone number" });
	}

	const job = await enqueueSms(env, {
		deviceId: body.deviceId,
		to: body.to,
		text: body.text,
	});

	return response(202, { accepted: true, id: job.id, queuedAt: job.createdAt });
}

async function handlePoll(request: Request, env: Env): Promise<Response> {
	if (!requireApiKey(request, env)) {
		return response(401, { error: "unauthorized" });
	}

	const url = new URL(request.url);
	const deviceId = url.searchParams.get("deviceId")?.trim();
	if (!deviceId) {
		return response(400, { error: "deviceId query param is required" });
	}

	const items = await getInbox(env, deviceId);
	if (items.length === 0) {
		return response(200, { hasMessage: false });
	}

	const item = items[0];
	const raw = await env.SMS_KV.get(recordKey(item.id));
	if (!raw) {
		// Drop orphan id if record is missing.
		await putInbox(env, deviceId, items.slice(1));
		return response(200, { hasMessage: false });
	}

	const message = JSON.parse(raw) as SmsRecord;
	if (message.status !== "pending") {
		// If already resolved, consume and continue.
		await putInbox(env, deviceId, items.slice(1));
		return response(200, { hasMessage: false });
	}

	return response(200, {
		hasMessage: true,
		message: {
			id: message.id,
			to: message.to,
			text: message.text,
			createdAt: message.createdAt,
		},
	});
}

async function handleAck(request: Request, env: Env): Promise<Response> {
	if (!requireApiKey(request, env)) {
		return response(401, { error: "unauthorized" });
	}

	const body = await readJson<{
		deviceId?: string;
		id?: string;
		status?: "sent" | "failed";
		error?: string;
	}>(request);

	if (!body?.deviceId || !body?.id || !body?.status) {
		return response(400, { error: "deviceId, id, status are required" });
	}

	if (body.status !== "sent" && body.status !== "failed") {
		return response(400, { error: "status must be sent or failed" });
	}

	const key = recordKey(body.id);
	const raw = await env.SMS_KV.get(key);
	if (!raw) {
		return response(404, { error: "message not found" });
	}

	const record = JSON.parse(raw) as SmsRecord;
	if (record.deviceId !== body.deviceId) {
		return response(403, { error: "message does not belong to device" });
	}

	const updated: SmsRecord = {
		...record,
		status: body.status,
		lastError: body.error,
		sentAt: body.status === "sent" ? new Date().toISOString() : undefined,
	};
	await env.SMS_KV.put(key, JSON.stringify(updated));

	const items = await getInbox(env, body.deviceId);
	const remaining = items.filter((it) => it.id !== body.id);
	await putInbox(env, body.deviceId, remaining);

	return response(200, { ok: true });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: jsonHeaders });
		}

		const url = new URL(request.url);
		const path = url.pathname;

		if (request.method === "POST" && path === "/api/sms/enqueue") {
			return handleEnqueue(request, env);
		}

		if (request.method === "GET" && path === "/api/sms/poll") {
			return handlePoll(request, env);
		}

		if (request.method === "POST" && path === "/api/sms/ack") {
			return handleAck(request, env);
		}

		if (request.method === "GET" && path === "/health") {
			return response(200, { ok: true, service: "sms-worker" });
		}

		return response(404, { error: "not found" });
	},

	async queue(batch: MessageBatch<SmsJob>, env: Env): Promise<void> {
		for (const msg of batch.messages) {
			try {
				const job = msg.body;
				const record: SmsRecord = {
					...job,
					status: "pending",
				};

				await env.SMS_KV.put(recordKey(job.id), JSON.stringify(record));

				const inbox = await getInbox(env, job.deviceId);
				inbox.push({ id: job.id });
				await putInbox(env, job.deviceId, inbox);

				msg.ack();
			} catch {
				msg.retry();
			}
		}
	},
};
