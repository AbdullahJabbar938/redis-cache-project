import express from 'express';
import mongoose from 'mongoose';
import { createClient } from 'redis';
import Product, { CATEGORIES } from './Product.js';

// ---------- Config (environment variables with local defaults) ----------
const PORT = Number(process.env.PORT ?? 4000);
const MONGO_URI = process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/node_cache';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const CACHE_ENABLED = (process.env.CACHE_ENABLED ?? 'true') !== 'false';
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? 60);

const CACHE_PREFIX = 'products:list:';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ALLOWED_FIELDS = ['name', 'price', 'category', 'specs']; // fields a client may write
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// ---------- Connections ----------
let redis = null;
if (CACHE_ENABLED) {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', (err) => console.error('Redis client error:', err.message));
    await redis.connect();
    console.log('Redis connected');
} else {
    console.log('Cache disabled (CACHE_ENABLED=false)');
}

try {
    await mongoose.connect(MONGO_URI);
    console.log(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
} catch (err) {
    console.error('Initial MongoDB connection failed:', err.message);
    process.exit(1);
}

// ---------- Cache helpers (the cache is best-effort: failures fall back to MongoDB) ----------
async function cacheGet(key) {
    if (!redis?.isReady) return null;
    try {
        const raw = await redis.get(key);
        return raw ? JSON.parse(raw) : null;
    } catch (err) {
        console.error('Cache read failed:', err.message);
        return null;
    }
}

async function cacheSet(key, value) {
    if (!redis?.isReady) return;
    try {
        await redis.set(key, JSON.stringify(value), { EX: CACHE_TTL_SECONDS });
    } catch (err) {
        console.error('Cache write failed:', err.message);
    }
}

// SCAN walks the keyspace in small batches instead of blocking Redis like KEYS does.
async function invalidateProductLists() {
    if (!redis?.isReady) return;
    try {
        for await (const batch of redis.scanIterator({ MATCH: `${CACHE_PREFIX}*`, COUNT: 100 })) {
            const keys = Array.isArray(batch) ? batch : [batch];
            if (keys.length > 0) await redis.del(keys);
        }
    } catch (err) {
        console.error('Cache invalidation failed:', err.message);
    }
}

// ---------- Small helpers ----------
function parsePositiveInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

function pickAllowed(body) {
    if (!body || typeof body !== 'object') return {};
    return Object.fromEntries(ALLOWED_FIELDS.filter((f) => f in body).map((f) => [f, body[f]]));
}

async function loadProducts(filter, page, limit) {
    const [data, total] = await Promise.all([
        Product.find(filter)
            .sort({ _id: 1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        Product.countDocuments(filter),
    ]);
    return { data, page, limit, total, totalPages: Math.ceil(total / limit) };
}

// Concurrent cache misses for the same key share one DB query (prevents a cache stampede
// within this process).
const inflight = new Map();

// ---------- App ----------
const app = express();
app.use(express.json());

app.param('id', (req, res, next, id) => {
    if (!OBJECT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid product id' });
    next();
});

app.get('/health', (req, res) => {
    const mongoUp = mongoose.connection.readyState === 1;
    res.status(mongoUp ? 200 : 503).json({
        status: mongoUp ? 'ok' : 'degraded',
        mongo: mongoUp,
        cache: redis?.isReady ?? false,
    });
});

// GET: list products (paginated, cached in Redis)
app.get('/api/products', async (req, res) => {
    const { category } = req.query;
    if (category !== undefined && (typeof category !== 'string' || !CATEGORIES.includes(category))) {
        return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
    }
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
    const filter = category ? { category } : {};

    // Baseline mode for benchmarking: always hit MongoDB.
    if (!CACHE_ENABLED) {
        res.set('X-Cache', 'BYPASS');
        return res.json(await loadProducts(filter, page, limit));
    }

    // Only validated params go into the key, so the set of possible keys stays bounded.
    const key = `${CACHE_PREFIX}${category ?? 'all'}:p${page}:l${limit}`;

    const cached = await cacheGet(key);
    if (cached) {
        res.set('X-Cache', 'HIT');
        return res.json(cached);
    }

    let pending = inflight.get(key);
    if (!pending) {
        pending = loadProducts(filter, page, limit)
            .then(async (result) => {
                await cacheSet(key, result);
                return result;
            })
            .finally(() => inflight.delete(key));
        inflight.set(key, pending);
    }
    const result = await pending;
    res.set('X-Cache', 'MISS');
    res.json(result);
});

// POST: create a product and invalidate cached lists
app.post('/api/products', async (req, res) => {
    const product = await Product.create(pickAllowed(req.body));
    await invalidateProductLists();
    res.status(201).json(product);
});

// PUT: update allowed fields and invalidate cached lists
app.put('/api/products/:id', async (req, res) => {
    const updates = pickAllowed(req.body);
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: `Provide at least one of: ${ALLOWED_FIELDS.join(', ')}` });
    }

    const product = await Product.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true, runValidators: true }
    );
    if (!product) return res.status(404).json({ error: 'Product not found' });

    await invalidateProductLists();
    res.json(product);
});

// DELETE: remove a product and invalidate cached lists
app.delete('/api/products/:id', async (req, res) => {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    await invalidateProductLists();
    res.status(204).end();
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler: client mistakes -> 400, everything else -> generic 500 (no internals leaked).
app.use((err, req, res, next) => {
    if (err.name === 'ValidationError' || err.name === 'CastError') {
        return res.status(400).json({ error: err.message });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON body' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});

// ---------- Start + graceful shutdown ----------
const server = app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

function shutdown(signal) {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
        try {
            if (redis?.isOpen) await (redis.close ? redis.close() : redis.quit());
            await mongoose.disconnect();
        } finally {
            process.exit(0);
        }
    });
    setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
