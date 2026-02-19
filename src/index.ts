import { onRequest } from 'firebase-functions/v2/https';
import express, { Request, Response, NextFunction } from 'express';
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
app.use(express.json());

const db = getFirestore();
const auth = getAuth();

interface User {
  id?: string;
  email?: string;
  role?: 'customer' | 'cashier' | 'admin';
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

const authenticateCashier = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decodedToken = await auth.verifyIdToken(token);
    const userDoc = await db.collection('cashiers').doc(decodedToken.uid).get();

    if (!userDoc.exists) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    req.user = {
      id: decodedToken.uid,
      email: decodedToken.email,
      role: userDoc.data()?.role || 'cashier'
    };

    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.get('/api/products', async (req: Request, res: Response) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;

    let query: any = db.collection('products');

    if (search && typeof search === 'string') {
      const sku = search.toUpperCase();
      query = query.where('sku', '==', sku);
    }

    query = query.limit(parseInt(limit as string)).offset(parseInt(offset as string));
    const snapshot = await query.get();
    const products = snapshot.docs.map((doc: any) => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      data: products,
      total: snapshot.size
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.post('/api/products', authenticateCashier, async (req: Request, res: Response) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { sku, name, price, description, color } = req.body;

    if (!sku || !name || !price) {
      return res.status(400).json({ error: 'Missing required fields: sku, name, price' });
    }

    const docRef = await db.collection('products').add({
      sku: sku.toUpperCase(),
      name,
      price: parseFloat(price),
      description: description || null,
      color: color || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    res.status(201).json({
      success: true,
      data: { id: docRef.id, sku, name, price }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create product' });
  }
});

app.post('/api/orders', async (req: Request, res: Response) => {
  try {
    const { items, customerEmail } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array required' });
    }

    const orderCode = Math.random().toString(36).substring(2, 11).toUpperCase();
    let total = 0;
    const processedItems = [];

    for (const item of items) {
      if (!item.productId || !item.quantity) {
        return res.status(400).json({ error: 'Each item must have productId and quantity' });
      }

      const productDoc = await db.collection('products').doc(item.productId).get();
      if (!productDoc.exists) {
        return res.status(400).json({ error: `Product ${item.productId} not found` });
      }

      const product = productDoc.data();
      if (!product) {
        return res.status(400).json({ error: `Product ${item.productId} not found` });
      }

      const itemTotal = product.price * item.quantity;
      total += itemTotal;

      processedItems.push({
        productId: item.productId,
        sku: product.sku,
        name: product.name,
        quantity: item.quantity,
        price: product.price,
        color: item.color || null,
        subtotal: itemTotal
      });
    }

    const docRef = await db.collection('orders').add({
      code: orderCode,
      items: processedItems,
      total,
      status: 'pending',
      customerEmail: customerEmail || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    res.status(201).json({
      success: true,
      data: {
        id: docRef.id,
        code: orderCode,
        total,
        status: 'pending'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.get('/api/orders/:orderCode', async (req: Request, res: Response) => {
  try {
    const { orderCode } = req.params;

    const snapshot = await db.collection('orders')
      .where('code', '==', orderCode.toUpperCase())
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'Order not found' });
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
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

app.put('/api/orders/:orderId', authenticateCashier, async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'paid', 'ready', 'delivered', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
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
    res.status(500).json({ error: 'Failed to update order' });
  }
});

app.post('/api/auth/cashier/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const cashierQuery = await db.collection('cashiers').where('email', '==', email).limit(1).get();

    if (cashierQuery.empty) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const cashier = cashierQuery.docs[0].data();

    if (cashier.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = await auth.createCustomToken(cashierQuery.docs[0].id);

    res.json({
      success: true,
      data: {
        token,
        cashier: {
          id: cashierQuery.docs[0].id,
          email: cashier.email,
          role: cashier.role
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/cashier/register', authenticateCashier, async (req: Request, res: Response) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { email, password, role = 'cashier' } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (!['cashier', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const existingQuery = await db.collection('cashiers').where('email', '==', email).limit(1).get();
    if (!existingQuery.empty) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const docRef = await db.collection('cashiers').add({
      email,
      password,
      role,
      createdAt: new Date().toISOString()
    });

    res.status(201).json({
      success: true,
      data: {
        id: docRef.id,
        email,
        role
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.get('/api/orders', authenticateCashier, async (req: Request, res: Response) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    let query: any = db.collection('orders');

    if (status && typeof status === 'string') {
      query = query.where('status', '==', status);
    }

    query = query.orderBy('createdAt', 'desc').limit(parseInt(limit as string)).offset(parseInt(offset as string));
    const snapshot = await query.get();

    const orders = snapshot.docs.map((doc: any) => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      data: orders,
      total: snapshot.size
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.post('/api/cart/validate', async (req: Request, res: Response) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Items array required' });
    }

    const validatedItems = [];
    let total = 0;

    for (const item of items) {
      const productDoc = await db.collection('products').doc(item.productId).get();

      if (!productDoc.exists) {
        return res.status(400).json({
          error: 'Product not found',
          productId: item.productId
        });
      }

      const product = productDoc.data();
      if (!product) {
        return res.status(400).json({
          error: 'Product not found',
          productId: item.productId
        });
      }

      const itemTotal = product.price * item.quantity;
      total += itemTotal;

      validatedItems.push({
        productId: item.productId,
        name: product.name,
        price: product.price,
        quantity: item.quantity,
        subtotal: itemTotal
      });
    }

    res.json({
      success: true,
      data: {
        items: validatedItems,
        total
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Validation failed' });
  }
});

export const api = onRequest({ cors: false }, app);
