import autocannon from 'autocannon';

// Configure with env vars, e.g. in PowerShell:
//   $env:BENCH_LABEL = "with-cache"; node benchmark.js
const url = process.env.BENCH_URL ?? 'http://localhost:4000/api/products?category=Laptops&limit=100';
const connections = Number(process.env.BENCH_CONNECTIONS ?? 100);
const duration = Number(process.env.BENCH_DURATION ?? 30);
const label = process.env.BENCH_LABEL ?? 'run';

const fmt = (n, digits = 2) => Number(n).toFixed(digits);

try {
    // Fail fast with a clear message if the server isn't up or returns an error.
    const probe = await fetch(url);
    if (!probe.ok) throw new Error(`Probe request returned HTTP ${probe.status}`);
    console.log(`Target: ${url}`);
    console.log(`X-Cache on probe request: ${probe.headers.get('x-cache') ?? '(none)'}`);
    console.log(`Running ${duration}s with ${connections} connections...\n`);

    const result = await autocannon({ url, connections, duration });

    console.log(`=== Benchmark: ${label} ===`);
    console.table({
        'Requests/sec (avg)': fmt(result.requests.average),
        'Total requests': result.requests.total,
        '2xx responses': result['2xx'],
        'Non-2xx responses': result.non2xx,
        Errors: result.errors,
        Timeouts: result.timeouts,
        'Latency avg (ms)': fmt(result.latency.average),
        'Latency p50 (ms)': fmt(result.latency.p50),
        'Latency p97.5 (ms)': fmt(result.latency.p97_5),
        'Latency p99 (ms)': fmt(result.latency.p99),
        'Latency max (ms)': fmt(result.latency.max),
        'Throughput avg (MB/s)': fmt(result.throughput.average / 1024 / 1024),
    });

    console.log('\nRow for the README table:');
    console.log(
        `| ${label} | ${fmt(result.requests.average, 0)} | ${fmt(result.latency.average)} ms | ${fmt(result.latency.p99)} ms |`
    );
} catch (error) {
    console.error('Benchmark failed:', error.message);
    process.exit(1);
}
