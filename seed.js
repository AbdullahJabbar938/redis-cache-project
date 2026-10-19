import mongoose from 'mongoose';
import Product, { CATEGORIES } from './Product.js';

const MONGO_URI = process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/node_cache';
// Usage: node seed.js [count]   (default 5000)
const COUNT = Number(process.argv[2] ?? process.env.SEED_COUNT ?? 5000);

await mongoose.connect(MONGO_URI);

await Product.deleteMany({});

const products = Array.from({ length: COUNT }, (_, i) => {
    const category = CATEGORIES[i % CATEGORIES.length];
    return {
        name: `${category} item ${i + 1}`,
        price: 100 + (i % 100) * 20,
        category,
        specs: {
            ram: ['8GB', '16GB', '32GB'][i % 3],
            storage: ['256GB SSD', '512GB SSD', '1TB SSD'][i % 3],
            cpu: ['Intel i5', 'Intel i7', 'Ryzen 7'][i % 3],
        },
    };
});

await Product.insertMany(products);
await Product.syncIndexes();

console.log(`Seeded ${products.length} products across ${CATEGORIES.length} categories`);
await mongoose.disconnect();
