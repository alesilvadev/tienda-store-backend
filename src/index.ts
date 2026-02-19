import { onRequest } from 'firebase-functions/v2/https';
import express from 'express';
import cors from 'cors';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp();

const app = express();

const allowedOrigins = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL, 'http://localhost:3000']
  : true;

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const db = getFirestore();
const auth = getAuth();

interface CashierUser {
  id: string;
  email: string;
  role: 'cashier' | 'admin';
}

declare global {
  namespace Express {
    interface Request {
      user?: CashierUser;
    }
  }
}

const sanitizeString = (str: string): string => {
  if (typeof str !== 'string') return '';
  return str.trim().substring(0, 255);
};

const validateEmail = (email: string): boolean => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
};

const validatePrice = (price: any): number => {
  const parsed = parseFloat(price);
  if (isNaN(parsed) || parsed < 0) {
    throw new Error('Invalid price');
  }
  return Math.round(parsed * 100) / 100;
};

const validateQuantity = (qty: any): number => {
  const parsed = parseInt(qty, 10);
  if (isNaN(parsed) || parsed < 1) {
    throw new Error('Invalid quantity');
  }
  return parsed;
};

const generateOrderCode = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

const authenticateCashier = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const decodedToken = await auth.verifyIdToken(token);
    const userDoc = await db.collection('cashiers').doc(decodedToken.uid).get();

    if (!userDoc.exists) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const userData = userDoc.data();
    if (!userData?.email || !userData?.role) {
      return res.status(403).json({ success: false, error: 'Invalid cashier data' });
    }

    req.user = {
      id: decodedToken.uid,
      email: userData.email,
      role: userData.role
    };

    next();
  } catch (error) {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
};

const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
};

app.get('/health', (req: express.Request, res: express.Response) => {
  res.json({ status: 'ok' });
});

app.get('/api/products', async (req: express.Request, res: express.Response) => {
  try {
    const { sku, limit = '50', offset = '0' } = req.query;

    const pageSize = Math.min(Math.max(parseInt(limit as string) || 50, 1), 500);
    const pageOffset = Math.max(parseInt(offset as string) || 0, 0);

    let query: any = db.collection('products');

    if (sku && typeof sku === 'string') {
      const searchSku = sanitizeString(sku).toUpperCase();
      query = query.where('sku', '==', searchSku);
    }

    query = query.orderBy('sku').limit(pageSize).offset(pageOffset);
    const snapshot = await query.get();

    const products = snapshot.docs.map((doc: any) => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      data: products,
      pagination: {
        limit: pageSize,
        offset: pageOffset,
        count: products.length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch products' });
  }
});

app.post('/api/products', authenticateCashier, requireAdmin, async (req: express.Request, res: express.Response) => {
  try {
    const { sku, name, price, description, color } = req.body;

    if (!sku || typeof sku !== 'string') {
      return res.status(400).json({ success: false, error: 'SKU is required' });
    }

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    if (!price) {
      return res.status(400).json({ success: false, error: 'Price is required' });
    }

    const cleanSku = sanitizeString(sku).toUpperCase();
    const cleanName = sanitizeString(name);
    const cleanPrice = validatePrice(price);

    const existing = await db.collection('products')
      .where('sku', '==', cleanSku)
      .limit(1)
      .get();

    if (!existing.empty) {
      return res.status(400).json({ success: false, error: 'Product with this SKU already exists' });
    }

    const docRef = await db.collection('products').add({
      sku: cleanSku,
      name: cleanName,
      price: cleanPrice,
      description: description ? sanitizeString(description) : null,
      color: color ? sanitizeString(color) : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    res.status(201).json({
      success: true,
      data: {
        id: docRef.id,
        sku: cleanSku,
        name: cleanName,
        price: cleanPrice
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to create product' });
  }
});

app.post('/api/orders', async (req: express.Request, res: express.Response) => {
  try {
    const { items, customerEmail } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Items array is required' });
    }

    if (items.length > 1000) {
      return res.status(400).json({ success: false, error: 'Too many items' });
    }

    let total = 0;
    const processedItems = [];

    for (const item of items) {
      if (!item.productId || typeof item.productId !== 'string') {
        return res.status(400).json({ success: false, error: 'Each item must have productId' });
      }

      let quantity: number;
      try {
        quantity = validateQuantity(item.quantity);
      } catch {
        return res.status(400).json({ success: false, error: 'Invalid quantity' });
      }

      const productDoc = await db.collection('products').doc(item.productId).get();
      if (!productDoc.exists) {
        return res.status(400).json({ success: false, error: `Product ${item.productId} not found` });
      }

      const product = productDoc.data();
      if (!product) {
        return res.status(400).json({ success: false, error: `Product ${item.productId} not found` });
      }

      const itemTotal = product.price * quantity;
      total += itemTotal;

      processedItems.push({
        productId: item.productId,
        sku: product.sku,
        name: product.name,
        quantity,
        price: product.price,
        color: item.color ? sanitizeString(item.color) : null,
        subtotal: Math.round(itemTotal * 100) / 100
      });
    }

    const orderCode = generateOrderCode();
    let normalizedEmail = null;

    if (customerEmail && typeof customerEmail === 'string') {
      const trimmed = sanitizeString(customerEmail);
      if (validateEmail(trimmed)) {
        normalizedEmail = trimmed.toLowerCase();
      }
    }

    const docRef = await db.collection('orders').add({
      code: orderCode,
      items: processedItems,
      total: Math.round(total * 100) / 100,
      status: 'pending',
      customerEmail: normalizedEmail,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    res.status(201).json({
      success: true,
      data: {
        id: docRef.id,
        code: orderCode,
        total: Math.round(total * 100) / 100,
        status: 'pending'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to create order' });
  }
});

app.get('/api/orders/code/:orderCode', async (req: express.Request, res: express.Response) => {
  try {
    const { orderCode } = req.params;

    if (!orderCode || typeof orderCode !== 'string') {
      return res.status(400).json({ success: false, error: 'Order code is required' });
    }

    const cleanCode = sanitizeString(orderCode).toUpperCase();

    const snapshot = await db.collection('orders')
      .where('code', '==', cleanCode)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const orderDoc = snapshot.docs[0];
    const order = {
      id: orderDoc.id,
      ...orderDoc.data()
    };

    res.json({
      success: true,
      data: order
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch order' });
  }
});

app.put('/api/orders/:orderId', authenticateCashier, async (req: express.Request, res: express.Response) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({ success: false, error: 'Order ID is required' });
    }

    const validStatuses = ['pending', 'confirmed', 'paid', 'ready', 'delivered', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    await orderRef.update({
      status,
      updatedAt: new Date().toISOString()
    });

    const updatedDoc = await orderRef.get();
    res.json({
      success: true,
      data: {
        id: updatedDoc.id,
        ...updatedDoc.data()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update order' });
  }
});

app.get('/api/orders', authenticateCashier, async (req: express.Request, res: express.Response) => {
  try {
    const { status, limit = '50', offset = '0' } = req.query;

    const pageSize = Math.min(Math.max(parseInt(limit as string) || 50, 1), 500);
    const pageOffset = Math.max(parseInt(offset as string) || 0, 0);

    let query: any = db.collection('orders');

    if (status && typeof status === 'string') {
      const validStatuses = ['pending', 'confirmed', 'paid', 'ready', 'delivered', 'cancelled'];
      if (validStatuses.includes(status)) {
        query = query.where('status', '==', status);
      }
    }

    query = query.orderBy('createdAt', 'desc').limit(pageSize).offset(pageOffset);
    const snapshot = await query.get();

    const orders = snapshot.docs.map((doc: any) => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      data: orders,
      pagination: {
        limit: pageSize,
        offset: pageOffset,
        count: orders.length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
});

app.post('/api/auth/cashier/login', async (req: express.Request, res: express.Response) => {
  try {
    const { email, password } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    if (!password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'Password is required' });
    }

    const cleanEmail = sanitizeString(email).toLowerCase();
    if (!validateEmail(cleanEmail)) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    try {
      const cashierUser = await auth.getUserByEmail(cleanEmail);
      const customToken = await auth.createCustomToken(cashierUser.uid);

      const cashierDoc = await db.collection('cashiers').doc(cashierUser.uid).get();
      const cashierData = cashierDoc.data();

      res.json({
        success: true,
        data: {
          token: customToken,
          cashier: {
            id: cashierUser.uid,
            email: cashierData?.email || cleanEmail,
            role: cashierData?.role || 'cashier'
          }
        }
      });
    } catch (authError) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

app.post('/api/auth/cashier/register', authenticateCashier, requireAdmin, async (req: express.Request, res: express.Response) => {
  try {
    const { email, role = 'cashier' } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const cleanEmail = sanitizeString(email).toLowerCase();
    if (!validateEmail(cleanEmail)) {
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }

    if (!['cashier', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role' });
    }

    try {
      await auth.getUserByEmail(cleanEmail);
      return res.status(400).json({ success: false, error: 'Email already registered' });
    } catch (error: any) {
      if (error.code !== 'auth/user-not-found') {
        throw error;
      }
    }

    const userRecord = await auth.createUser({
      email: cleanEmail,
      password: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
    });

    await db.collection('cashiers').doc(userRecord.uid).set({
      email: cleanEmail,
      role,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    res.status(201).json({
      success: true,
      data: {
        id: userRecord.uid,
        email: cleanEmail,
        role
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

app.post('/api/cart/validate', async (req: express.Request, res: express.Response) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Items array is required' });
    }

    if (items.length > 1000) {
      return res.status(400).json({ success: false, error: 'Too many items' });
    }

    const validatedItems = [];
    let total = 0;

    for (const item of items) {
      if (!item.productId || typeof item.productId !== 'string') {
        return res.status(400).json({ success: false, error: 'Each item must have productId' });
      }

      let quantity: number;
      try {
        quantity = validateQuantity(item.quantity);
      } catch {
        return res.status(400).json({ success: false, error: 'Invalid quantity' });
      }

      const productDoc = await db.collection('products').doc(item.productId).get();
      if (!productDoc.exists) {
        return res.status(400).json({
          success: false,
          error: 'Product not found',
          productId: item.productId
        });
      }

      const product = productDoc.data();
      if (!product) {
        return res.status(400).json({
          success: false,
          error: 'Product not found',
          productId: item.productId
        });
      }

      const itemTotal = product.price * quantity;
      total += itemTotal;

      validatedItems.push({
        productId: item.productId,
        sku: product.sku,
        name: product.name,
        price: product.price,
        quantity,
        subtotal: Math.round(itemTotal * 100) / 100
      });
    }

    res.json({
      success: true,
      data: {
        items: validatedItems,
        total: Math.round(total * 100) / 100
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Validation failed' });
  }
});

app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.status(500).json({ success: false, error: 'Internal server error' });
});

export const api = onRequest({ cors: false }, app);
