import mongoose from 'mongoose';

// Fixed list of categories. Besides validation, this keeps the set of possible
// cache keys small (a client can't invent categories to flood Redis).
export const CATEGORIES = ['Laptops', 'Phones', 'Tablets', 'Accessories'];

const productSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, maxlength: 200 },
        price: { type: Number, required: true, min: 0 },
        category: { type: String, required: true, enum: CATEGORIES },
        specs: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { timestamps: true }
);

// Supports "filter by category + stable pagination sorted by _id".
productSchema.index({ category: 1, _id: 1 });

export default mongoose.models.Product ?? mongoose.model('Product', productSchema);
