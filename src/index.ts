"use strict";

import { Hono } from 'hono'
import { html } from 'hono/html'

import {
    Event,
    getEventHash,
    getPublicKey,
    finalizeEvent,
    nip19,
    SimplePool,
    verifyEvent,
} from "nostr-tools";

import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

const cache = caches.default;

export interface Env {
    TODO_NSEC: string;
    ASSETS: Fetcher;
    nostr_todo: D1Database;
}

const pool = new SimplePool();
const relays = ['wss://yabu.me', 'wss://relay-jp.nostr.wirednet.jp', 'wss://nos.lol', 'wss://relay.damus.io']

type Bindings = {
    DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

function notAuthenticated(_request: Request, _env: Env) {
    return new Response(
        "Not Authenticated",
        {
            status: 401,
            headers: {
                "content-type": "text/plain; charset=UTF-8",
                "accept-charset": "utf-8",
            },
        },
    );
}

function notFound(_request: Request, _env: Env) {
    return new Response(`Not found`, {
        status: 404,
    });
}

function unsupportedMethod(_request: Request, _env: Env) {
    return new Response(`Unsupported method`, {
        status: 400,
    });
}

function bearerAuthentication(request: Request, secret: string) {
    if (!request.headers.has("authorization")) {
        return false;
    }
    const authorization = request.headers.get("Authorization")!;
    const [scheme, encoded] = authorization.split(" ");
    return scheme === "Bearer" && encoded === secret;
}

function createReplyWithTags(
    nsec: string,
    mention: Event,
    message: string,
    tags: string[][],
    notice: boolean = true,
): Event {
    if (!nsec) throw new Error("TODO_NSEC environment variable is not set");
    const decoded = nip19.decode(nsec);
    const sk = decoded.data as Uint8Array;
    const pk = getPublicKey(sk);
    if (mention.pubkey === pk) throw new Error("Self reply not acceptable");
    const tt = [];
    if (notice) tt.push(["e", mention.id], ["p", mention.pubkey]);
    else tt.push(["e", mention.id]);
    if (mention.kind === 42) {
        for (let tag of mention.tags.filter((x: any[]) => x[0] === "e")) {
            tt.push(tag);
        }
    }
    for (let tag of tags) {
        tt.push(tag);
    }
    const created_at = mention.created_at + 1;
    let event = {
        id: "",
        kind: mention.kind,
        pubkey: pk,
        created_at: created_at,
        tags: tt,
        content: message,
        sig: "",
    };
    event.id = getEventHash(event);
    event = finalizeEvent(event, sk);
    return event;
}

function createNoteWithTags(
    nsec: string,
    mention: Event,
    message: string,
    tags: string[][],
): Event {
    const decoded = nip19.decode(nsec);
    const sk = decoded.data as Uint8Array;
    const pk = getPublicKey(sk);
    const tt = [];
    if (mention.kind === 42) {
        for (let tag of mention.tags.filter((x: any[]) => x[0] === "e")) {
            tt.push(tag);
        }
    }
    for (let tag of tags) {
        tt.push(tag);
    }
    const created_at = mention.created_at + 1;
    let event = {
        id: "",
        kind: mention.kind,
        pubkey: pk,
        created_at: created_at,
        tags: tt,
        content: message,
        sig: "",
    };
    event.id = getEventHash(event);
    event = finalizeEvent(event, sk);
    return event;
}

function JSONResponse(value: any): Response {
    if (value === null) return new Response("");
    return new Response(JSON.stringify(value), {
        headers: {
            "access-control-allow-origin": "*",
            "content-type": "application/json; charset=UTF-8",
        },
    });
}

function cleanContent(content: string): string {
    return content.replace(/nostr:[a-z0-9]+/gi, '').trim();
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getHelpMessage(): string {
    return `使い方:
list - TODO一覧
add <内容> - TODO追加
show <ID> - TODO表示
done <ID> - TODO完了
delete <ID> - TODO削除
search <キーワード> - TODO検索
web - Web表示URL`;
}

async function handleMentionDirect(mention: Event, env: Env): Promise<Response> {
    // Verify event signature
    if (!verifyEvent(mention)) {
        return JSONResponse(
            createReplyWithTags(env.TODO_NSEC, mention, 'Invalid event signature', []),
        );
    }
    
    const pubkey = mention.pubkey;
    const content = cleanContent(mention.content);

    if (/^list$/i.test(content)) {
        const { results } = await env.nostr_todo.prepare(
            'SELECT user_id, content FROM todos WHERE pubkey = ? AND completed = 0 ORDER BY created_at ASC'
        ).bind(pubkey).all();

        let message = '';
        if (results.length === 0) {
            message = 'No todos';
        } else {
            message = results.map((row: any) => {
                const preview = row.content.replace(/\s+/g, ' ').trim().substring(0, 20);
                const truncated = row.content.length > 20 ? '...' : '';
                return `${row.user_id}. ${preview}${truncated}`;
            }).join('\n');
        }

        return JSONResponse(
            createReplyWithTags(env.TODO_NSEC, mention, message, []),
        );
    }

    const addMatch = content.match(/^add\s+(.+)$/is);
    if (addMatch) {
        const todoContent = addMatch[1].trim();
        if (!todoContent) {
            return JSONResponse(
                createReplyWithTags(env.TODO_NSEC, mention, 'Usage: add <content>', []),
            );
        }

        const { results } = await env.nostr_todo.prepare(
            'SELECT COALESCE(MAX(user_id), 0) + 1 as next_id FROM todos WHERE pubkey = ?'
        ).bind(pubkey).all();
        const userId = (results[0] as any).next_id;

        await env.nostr_todo.prepare(
            'INSERT INTO todos (pubkey, content, completed, created_at, user_id) VALUES (?, ?, 0, ?, ?)'
        ).bind(pubkey, todoContent, Math.floor(Date.now() / 1000), userId).run();

        return JSONResponse(
            createReplyWithTags(env.TODO_NSEC, mention, `Added: ${userId}`, []),
        );
    }

    const deleteMatch = content.match(/^delete\s+(\d+)$/i);
    if (deleteMatch) {
        const userId = parseInt(deleteMatch[1]);
        const result = await env.nostr_todo.prepare(
            'DELETE FROM todos WHERE user_id = ? AND pubkey = ?'
        ).bind(userId, pubkey).run();

        const message = result.meta.changes > 0
            ? `Deleted: ${userId}`
            : `Not found: ${userId}`;

        return JSONResponse(
            createReplyWithTags(env.TODO_NSEC, mention, message, []),
        );
    }

    const doneMatch = content.match(/^done\s+(\d+)$/i);
    if (doneMatch) {
        const userId = parseInt(doneMatch[1]);
        const result = await env.nostr_todo.prepare(
            'UPDATE todos SET completed = 1 WHERE user_id = ? AND pubkey = ? AND completed = 0'
        ).bind(userId, pubkey).run();

        const message = result.meta.changes > 0
            ? `Done: ${userId}`
            : `Not found: ${userId}`;

        return JSONResponse(
            createReplyWithTags(env.TODO_NSEC, mention, message, []),
        );
    }

    const searchMatch = content.match(/^search\s+(.+)$/i);
    if (searchMatch) {
        const keyword = searchMatch[1].trim();
        const { results } = await env.nostr_todo.prepare(
            'SELECT user_id, content FROM todos WHERE pubkey = ? AND completed = 0 AND content LIKE ? ORDER BY created_at ASC'
        ).bind(pubkey, `%${keyword}%`).all();

        let message = '';
        if (results.length === 0) {
            message = 'No todos found';
        } else {
            message = results.map((row: any) => {
                const preview = row.content.replace(/\s+/g, ' ').trim().substring(0, 20);
                const truncated = row.content.length > 20 ? '...' : '';
                return `${row.user_id}. ${preview}${truncated}`;
            }).join('\n');
        }

        return JSONResponse(
            createReplyWithTags(env.TODO_NSEC, mention, message, []),
        );
    }

    const showMatch = content.match(/^show\s+(\d+)$/i);
    if (showMatch) {
        const userId = parseInt(showMatch[1]);
        const { results } = await env.nostr_todo.prepare(
            'SELECT user_id, content FROM todos WHERE user_id = ? AND pubkey = ?'
        ).bind(userId, pubkey).all();

        let message = '';
        if (results.length === 0) {
            message = `Not found: ${userId}`;
        } else {
            const row: any = results[0];
            message = `${row.user_id}. ${row.content}`;
        }

        return JSONResponse(
            createReplyWithTags(env.TODO_NSEC, mention, message, []),
        );
    }

    if (/^web$/i.test(content)) {
        const npub = nip19.npubEncode(pubkey);
        const url = `https://nostr-todo.compile-error.net/${npub}`;
        return JSONResponse(
            createReplyWithTags(env.TODO_NSEC, mention, url, []),
        );
    }

    return JSONResponse(
        createReplyWithTags(env.TODO_NSEC, mention, getHelpMessage(), []),
    );
}

async function handleMention(request: Request, env: Env): Promise<Response> {
    const mention: Event = await request.json();
    return handleMentionDirect(mention, env);
}

async function handleCall(request: Request, env: Env): Promise<Response> {
    const mention: Event = await request.json();
    
    // Verify event signature
    if (!verifyEvent(mention)) {
        return JSONResponse(
            createReplyWithTags(env.TODO_NSEC, mention, 'Invalid event signature', []),
        );
    }
    
    const content = cleanContent(mention.content);
    
    // "todoさん" の後にコマンドがあれば handleMention へ
    if (/^todo\s*さん\s+.+/i.test(content)) {
        // contentから "todoさん" を削除してhandleMentionへ
        const modifiedContent = content.replace(/^todo\s*さん\s+/i, '');
        const modifiedMention = { ...mention, content: modifiedContent };
        // handleMentionを直接呼び出し（Requestオブジェクトは不要）
        return handleMentionDirect(modifiedMention, env);
    }
    
    return JSONResponse(
        createReplyWithTags(env.TODO_NSEC, mention, `はい\n\n${getHelpMessage()}`, []),
    );
}

async function handleWebView(npub: string, env: Env, format: 'html' | 'json' = 'html'): Promise<Response> {
    try {
        const decoded = nip19.decode(npub);
        const pubkey = decoded.data as string;
        
        // Try to get profile from cache
        const cacheKey = `https://nostr-todo.compile-error.net/profile/${pubkey}`;
        let cachedResponse = await cache.match(cacheKey);
        let profile: any = { name: npub.substring(0, 12) + '...', picture: '' };
        
        if (cachedResponse) {
            profile = await cachedResponse.json();
        } else {
            // Fetch profile from relays
            try {
                const events = await pool.querySync(relays, { kinds: [0], authors: [pubkey], limit: 1 });
                if (events.length > 0) {
                    const metadata = JSON.parse(events[0].content);
                    profile = {
                        name: metadata.name || metadata.display_name || profile.name,
                        picture: metadata.picture || ''
                    };
                    
                    // Cache profile for 1 hour
                    const profileResponse = new Response(JSON.stringify(profile), {
                        headers: {
                            'Content-Type': 'application/json',
                            'Cache-Control': 'public, max-age=3600'
                        }
                    });
                    await cache.put(cacheKey, profileResponse);
                }
            } catch (e) {
                console.error('Failed to fetch profile from relays:', e);
            }
            
            // Fallback to HTTP API if relay fetch failed
            if (!profile.picture && profile.name.startsWith('npub')) {
                try {
                    const fallbackUrl = `https://nostr-nullpoga.compile-error.net/profile/${npub}`;
                    const fallbackResponse = await fetch(fallbackUrl);
                    if (fallbackResponse.ok) {
                        const metadata: any = await fallbackResponse.json();
                        profile = {
                            name: metadata.name || metadata.display_name || profile.name,
                            picture: metadata.picture || ''
                        };
                        
                        // Cache profile for 1 hour
                        const profileResponse = new Response(JSON.stringify(profile), {
                            headers: {
                                'Content-Type': 'application/json',
                                'Cache-Control': 'public, max-age=3600'
                            }
                        });
                        await cache.put(cacheKey, profileResponse);
                    }
                } catch (e) {
                    console.error('Failed to fetch profile from fallback API:', e);
                }
            }
        }
        
        const { results } = await env.nostr_todo.prepare(
            'SELECT user_id, content, completed, created_at FROM todos WHERE pubkey = ? ORDER BY completed ASC, created_at ASC'
        ).bind(pubkey).all();
        
        const incompleteTodos = results.filter((r: any) => r.completed === 0);
        const completedTodos = results.filter((r: any) => r.completed === 1);
        
        // JSON format
        if (format === 'json') {
            return new Response(JSON.stringify({
                npub,
                pubkey,
                profile,
                todos: {
                    incomplete: incompleteTodos.map((t: any) => ({
                        id: t.user_id,
                        content: t.content,
                        completed: false,
                        created_at: t.created_at
                    })),
                    completed: completedTodos.map((t: any) => ({
                        id: t.user_id,
                        content: t.content,
                        completed: true,
                        created_at: t.created_at
                    }))
                }
            }, null, 2), {
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
        
        const htmlContent = `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TODO List - ${escapeHtml(profile.name)}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 40px;
            color: white;
        }
        .profile {
            display: flex;
            align-items: center;
            gap: 20px;
        }
        .profile-icon {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            object-fit: cover;
            border: 4px solid rgba(255, 255, 255, 0.3);
            background: rgba(255, 255, 255, 0.2);
        }
        .profile-info { flex: 1; }
        .profile-name {
            font-size: 2em;
            font-weight: bold;
            margin-bottom: 8px;
            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.2);
        }
        .profile-npub {
            font-size: 0.85em;
            opacity: 0.9;
            word-break: break-all;
            font-family: monospace;
            background: rgba(255, 255, 255, 0.2);
            padding: 8px 12px;
            border-radius: 8px;
            display: inline-block;
        }
        .content { padding: 40px; }
        .section {
            margin-bottom: 40px;
        }
        .section:last-child { margin-bottom: 0; }
        .section-header {
            display: flex;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 12px;
            border-bottom: 2px solid #f0f0f0;
        }
        .section-title {
            font-size: 1.3em;
            font-weight: 600;
            color: #333;
            flex: 1;
        }
        .section-count {
            background: #667eea;
            color: white;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.9em;
            font-weight: bold;
        }
        .section.completed .section-count {
            background: #10b981;
        }
        .empty-state {
            text-align: center;
            padding: 40px;
            color: #999;
            font-size: 1.1em;
        }
        .todo {
            background: white;
            margin: 12px 0;
            padding: 20px;
            border: 2px solid #f0f0f0;
            border-radius: 12px;
            transition: all 0.2s ease;
            position: relative;
        }
        .todo:hover {
            border-color: #667eea;
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.1);
            transform: translateY(-2px);
        }
        .todo.completed {
            background: #f9fafb;
            border-color: #e5e7eb;
        }
        .todo.completed:hover {
            border-color: #10b981;
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.1);
        }
        .todo-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 12px;
        }
        .todo-id {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 6px 14px;
            border-radius: 20px;
            font-weight: bold;
            font-size: 0.9em;
            min-width: 40px;
            text-align: center;
        }
        .todo.completed .todo-id {
            background: #10b981;
        }
        .todo-content {
            white-space: pre-wrap;
            word-wrap: break-word;
            line-height: 1.6;
            color: #333;
            font-size: 1.05em;
        }
        .todo-date {
            margin-top: 8px;
            font-size: 0.85em;
            color: #999;
            font-style: italic;
        }
        .todo.completed .todo-content {
            text-decoration: line-through;
            color: #999;
        }
        @media (max-width: 600px) {
            body { padding: 10px; }
            .header { padding: 30px 20px; }
            .content { padding: 20px; }
            .profile-name { font-size: 1.5em; }
            .profile-icon { width: 60px; height: 60px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="profile">
                ${profile.picture ? `<img src="${escapeHtml(profile.picture)}" alt="${escapeHtml(profile.name)}" class="profile-icon" onerror="this.style.display='none'">` : '<div class="profile-icon"></div>'}
                <div class="profile-info">
                    <div class="profile-name">${escapeHtml(profile.name)}</div>
                    <div class="profile-npub">${escapeHtml(npub)}</div>
                </div>
            </div>
        </div>
        
        <div class="content">
            <div class="section">
                <div class="section-header">
                    <div class="section-title">📝 未完了</div>
                    <div class="section-count">${incompleteTodos.length}</div>
                </div>
                ${incompleteTodos.length === 0 ? '<div class="empty-state">🎉 すべて完了しました！</div>' : incompleteTodos.map((todo: any) => `
                <div class="todo">
                    <div class="todo-header">
                        <div class="todo-id">${escapeHtml(String(todo.user_id))}</div>
                    </div>
                    <div class="todo-content">${escapeHtml(todo.content)}</div>
                    <div class="todo-date">${new Date(todo.created_at * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</div>
                </div>
                `).join('')}
            </div>
            
            <div class="section completed">
                <div class="section-header">
                    <div class="section-title">✅ 完了</div>
                    <div class="section-count">${completedTodos.length}</div>
                </div>
                ${completedTodos.length === 0 ? '<div class="empty-state">完了したTODOはありません</div>' : completedTodos.map((todo: any) => `
                <div class="todo completed">
                    <div class="todo-header">
                        <div class="todo-id">${escapeHtml(String(todo.user_id))}</div>
                    </div>
                    <div class="todo-content">${escapeHtml(todo.content)}</div>
                    <div class="todo-date">${new Date(todo.created_at * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</div>
                </div>
                `).join('')}
            </div>
        </div>
    </div>
</body>
</html>`;
        
        return new Response(htmlContent, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    } catch (e) {
        return new Response('Invalid npub', { status: 400 });
    }
}

export default {
    async fetch(
        request: Request,
        env: Env,
    ): Promise<Response> {
        const { protocol, pathname } = new URL(request.url);
        const pathArray = pathname.split("/");

        if (
            "https:" !== protocol ||
            "https" !== request.headers.get("x-forwarded-proto")
        ) {
            throw new Error("Please use a HTTPS connection.");
        }

        console.log(`${request.method}: ${request.url} `);

        if (request.method === "GET") {
            if (pathArray[1] && pathArray[1].startsWith("npub")) {
                const format = pathArray[1].endsWith('.json') ? 'json' : 'html';
                const npub = pathArray[1].replace(/\.json$/, '');
                return handleWebView(npub, env, format);
            }
            return env.ASSETS.fetch(request);
        }
        if (request.method === "POST" && pathArray[1] === "mention") {
            return handleMention(request, env);
        }

        if (request.method === "POST" && pathArray[1] === "call") {
            return handleCall(request, env);
        }

        return unsupportedMethod(request, env);
    },
};
