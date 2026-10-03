export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      // ==========================================
      // ADMIN API (D1 SQL)
      // ==========================================
      if (request.method === "POST" && url.pathname === "/api/admin/setup") {
          const body = await request.json();
          if (body.storeId && body.stripeKey) {
              await env.DB.prepare("INSERT INTO stores (store_id, stripe_key) VALUES (?, ?) ON CONFLICT(store_id) DO UPDATE SET stripe_key = excluded.stripe_key")
                  .bind(body.storeId, body.stripeKey).run();
              return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
          }
          return new Response("Bad Request", { status: 400, headers: corsHeaders });
      }

      // PRODUCT CRUD
      if (request.method === "GET" && url.pathname === "/api/admin/catalog") {
          const storeId = url.searchParams.get("storeId");
          if (!storeId) return new Response(JSON.stringify({ error: "Missing storeId" }), { status: 400, headers: corsHeaders });
          const { results } = await env.DB.prepare("SELECT * FROM products WHERE store_id = ?").bind(storeId).all();
          return new Response(JSON.stringify(results), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (request.method === "POST" && url.pathname === "/api/admin/catalog") {
          const body = await request.json();
          if (body.storeId && body.barcode && body.name && body.price !== undefined && body.stock !== undefined) {
              await env.DB.prepare("INSERT INTO products (barcode, store_id, name, price, stock) VALUES (?, ?, ?, ?, ?) ON CONFLICT(barcode, store_id) DO UPDATE SET name = excluded.name, price = excluded.price, stock = excluded.stock")
                  .bind(body.barcode, body.storeId, body.name, body.price, body.stock).run();
              return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
          }
          return new Response("Bad Request", { status: 400, headers: corsHeaders });
      }
      
      if (request.method === "DELETE" && url.pathname === "/api/admin/catalog") {
          const storeId = url.searchParams.get("storeId");
          const barcode = url.searchParams.get("barcode");
          if (storeId && barcode) {
              await env.DB.prepare("DELETE FROM products WHERE store_id = ? AND barcode = ?").bind(storeId, barcode).run();
              return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
          }
          return new Response("Bad Request", { status: 400, headers: corsHeaders });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/devices") {
          const { results: devices } = await env.DB.prepare("SELECT * FROM devices").all();
          return new Response(JSON.stringify(devices), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/live-carts") {
          const { results: carts } = await env.DB.prepare("SELECT * FROM carts").all();
          return new Response(JSON.stringify(carts), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // ==========================================
      // DEVICE & CART API (D1 SQL)
      // ==========================================
      if (request.method === "POST" && url.pathname === "/api/device/register") {
          const body = await request.json();
          const deviceId = body.deviceId;
          const type = body.type || "unknown";
          if (!deviceId) return new Response(JSON.stringify({ error: "Missing deviceId" }), { status: 400, headers: corsHeaders });
          
          await env.DB.prepare("INSERT INTO devices (device_id, type) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seen = CURRENT_TIMESTAMP")
              .bind(deviceId, type).run();
          return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
      }

      // Handle both GET /api/cart?deviceId=... and GET /api/cart/{deviceId}
      if (request.method === "GET" && (url.pathname === "/api/cart" || url.pathname.startsWith("/api/cart/"))) {
        let deviceId = url.searchParams.get("deviceId");
        if (!deviceId && url.pathname.startsWith("/api/cart/")) {
            deviceId = url.pathname.replace("/api/cart/", "");
        }
        if(!deviceId) return new Response(JSON.stringify({ error: "Missing deviceId" }), { status: 400, headers: corsHeaders });

        const { results: cartItems } = await env.DB.prepare("SELECT id, barcode, name, price, quantity FROM carts WHERE device_id = ?").bind(deviceId).all();
        let total = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        return new Response(JSON.stringify({ items: cartItems, total: total }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (request.method === "POST" && url.pathname === "/api/cart/add") {
        const body = await request.json();
        const barcode = body.barcode;
        const deviceId = body.deviceId;
        
        if(!deviceId || !barcode) return new Response(JSON.stringify({ error: "Missing payload" }), { status: 400, headers: corsHeaders });
        
        await env.DB.prepare("INSERT INTO devices (device_id, type) VALUES (?, 'display') ON CONFLICT(device_id) DO UPDATE SET last_seen = CURRENT_TIMESTAMP").bind(deviceId).run();

        if (barcode.startsWith("STORE-CHECKIN-")) {
            const remainder = barcode.replace("STORE-CHECKIN-", "");
            const newStoreId = remainder.split("-")[0];
            await env.DB.prepare("INSERT INTO active_sessions (device_id, store_id) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET store_id = excluded.store_id").bind(deviceId, newStoreId).run();
            await env.DB.prepare("DELETE FROM carts WHERE device_id = ?").bind(deviceId).run(); // Clear old cart
            return new Response(JSON.stringify({ status: "success", productName: `Checked into ${newStoreId}`, price: "0.00", cartTotal: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const session = await env.DB.prepare("SELECT store_id FROM active_sessions WHERE device_id = ?").bind(deviceId).first();
        if (!session) {
            return new Response(JSON.stringify({ status: "error", error: "Please scan a Store Check-In Barcode first!" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const storeId = session.store_id;

        let product = await env.DB.prepare("SELECT name, price, stock FROM products WHERE barcode = ? AND store_id = ?").bind(barcode, storeId).first();
        if (product && product.stock <= 0) {
            return new Response(JSON.stringify({ status: "error", error: "Product out of stock" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        if (!product) {
            let globalName = "Unknown Product";
            try {
                const upcRes = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`);
                if (upcRes.ok) {
                    const upcData = await upcRes.json();
                    if (upcData.items && upcData.items.length > 0) globalName = upcData.items[0].title;
                }
            } catch (e) {}

            if (globalName !== "Unknown Product") {
                return new Response(JSON.stringify({ status: "error", error: `Found '${globalName.substring(0, 20)}...', but Store '${storeId}' hasn't set a price.` }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            } else {
                return new Response(JSON.stringify({ status: "error", error: "Barcode not recognized locally or globally." }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
        }

        const existing = await env.DB.prepare("SELECT id, quantity FROM carts WHERE device_id = ? AND barcode = ?").bind(deviceId, barcode).first();
        if (existing) {
            await env.DB.prepare("UPDATE carts SET quantity = quantity + 1 WHERE id = ?").bind(existing.id).run();
        } else {
            await env.DB.prepare("INSERT INTO carts (device_id, barcode, name, price, quantity) VALUES (?, ?, ?, ?, 1)").bind(deviceId, barcode, product.name, product.price).run();
        }

        const { results: cartItems } = await env.DB.prepare("SELECT price, quantity FROM carts WHERE device_id = ?").bind(deviceId).all();
        let total = cartItems.reduce((sum, item) => sum + ((item.price || 0) * item.quantity), 0);
        
        return new Response(JSON.stringify({ status: "success", productName: product.name, price: product.price ? product.price.toFixed(2) : "0.00", cartTotal: total }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (request.method === "POST" && url.pathname === "/api/cart/update") {
          const body = await request.json();
          const { cartId, quantity, deviceId } = body;
          if (!cartId || quantity === undefined) return new Response(JSON.stringify({ error: "Missing payload" }), { status: 400, headers: corsHeaders });
          
          await env.DB.prepare("UPDATE carts SET quantity = ? WHERE id = ?").bind(quantity, cartId).run();
          return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
      }

      if (request.method === "POST" && url.pathname === "/api/cart/remove") {
          const body = await request.json();
          const { cartId, deviceId } = body;
          if (!cartId) return new Response(JSON.stringify({ error: "Missing cartId" }), { status: 400, headers: corsHeaders });
          
          await env.DB.prepare("DELETE FROM carts WHERE id = ?").bind(cartId).run();
          return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
      }

      if (request.method === "POST" && url.pathname === "/api/cart/create-checkout-session") {
        const body = await request.json();
        const deviceId = body.deviceId;
        if(!deviceId) return new Response(JSON.stringify({ error: "Missing deviceId" }), { status: 400, headers: corsHeaders });

        const { results: cartItems } = await env.DB.prepare("SELECT name, price, quantity FROM carts WHERE device_id = ?").bind(deviceId).all();
        if (cartItems.length === 0) {
            return new Response(JSON.stringify({ error: "Cart is empty" }), { status: 400, headers: corsHeaders });
        }

        const session = await env.DB.prepare("SELECT store_id FROM active_sessions WHERE device_id = ?").bind(deviceId).first();
        if (!session) {
            return new Response(JSON.stringify({ error: "No active store session. Please scan a Store Check-In barcode." }), { status: 400, headers: corsHeaders });
        }
        const storeId = session.store_id;
        
        const store = await env.DB.prepare("SELECT stripe_key FROM stores WHERE store_id = ?").bind(storeId).first();
        let storeStripeKey = store ? store.stripe_key : env.STRIPE_SECRET_KEY;

        if (!storeStripeKey) {
            return new Response(JSON.stringify({ error: `Store '${storeId}' has not configured their Stripe Bank Account.` }), { status: 500, headers: corsHeaders });
        }

        const stripeParams = new URLSearchParams();
        stripeParams.append('success_url', `${url.origin}/cart.html?success=true`);
        stripeParams.append('cancel_url', `${url.origin}/cart.html?canceled=true`);
        stripeParams.append('mode', 'payment');

        cartItems.forEach((item, index) => {
            stripeParams.append(`line_items[${index}][price_data][currency]`, 'usd');
            stripeParams.append(`line_items[${index}][price_data][product_data][name]`, item.name);
            stripeParams.append(`line_items[${index}][price_data][unit_amount]`, Math.round((item.price || 0) * 100)); // Stripe uses cents
            stripeParams.append(`line_items[${index}][quantity]`, item.quantity);
        });

        const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${storeStripeKey}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: stripeParams.toString()
        });

        const stripeSession = await stripeRes.json();
        if (stripeSession.error) return new Response(JSON.stringify({ error: stripeSession.error.message }), { status: 400, headers: corsHeaders });
        return new Response(JSON.stringify({ url: stripeSession.url }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (request.method === "POST" && url.pathname === "/api/cart/checkout") {
        const body = await request.json();
        const deviceId = body.deviceId;
        if(!deviceId) return new Response(JSON.stringify({ error: "Missing deviceId" }), { status: 400, headers: corsHeaders });

        const { results: cartItems } = await env.DB.prepare("SELECT barcode, name, price, quantity FROM carts WHERE device_id = ?").bind(deviceId).all();
        if (cartItems.length > 0) {
            let total = cartItems.reduce((sum, item) => sum + ((item.price || 0) * item.quantity), 0);
            
            const session = await env.DB.prepare("SELECT store_id FROM active_sessions WHERE device_id = ?").bind(deviceId).first();
            const storeId = session ? session.store_id : "unknown";

            await env.DB.prepare("INSERT INTO order_history (device_id, store_id, total) VALUES (?, ?, ?)")
                                         .bind(deviceId, storeId, total).run();
            
            const lastOrder = await env.DB.prepare("SELECT id FROM order_history WHERE device_id = ? ORDER BY id DESC LIMIT 1").bind(deviceId).first();
            const orderId = lastOrder.id;

            for (const item of cartItems) {
                await env.DB.prepare("INSERT INTO order_items (order_id, name, price, quantity) VALUES (?, ?, ?, ?)").bind(orderId, item.name, item.price, item.quantity).run();
                await env.DB.prepare("UPDATE products SET stock = stock - ? WHERE barcode = ? AND store_id = ?").bind(item.quantity, item.barcode, storeId).run();
            }

            await env.DB.prepare("DELETE FROM carts WHERE device_id = ?").bind(deviceId).run();
        }
        
        return new Response(JSON.stringify({ status: "success" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (request.method === "POST" && url.pathname === "/api/band/pair") {
        const body = await request.json();
        if(!body.deviceId) return new Response("Missing deviceId", { status: 400, headers: corsHeaders });
        
        await env.DB.prepare("INSERT OR REPLACE INTO active_sessions (device_id, store_id) VALUES (?, 'PENDING')").bind(body.deviceId).run();
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (request.method === "GET" && url.pathname === "/api/band/status") {
        const deviceId = url.searchParams.get("deviceId");
        if(!deviceId) return new Response("Missing deviceId", { status: 400, headers: corsHeaders });
        
        const session = await env.DB.prepare("SELECT store_id FROM active_sessions WHERE device_id = ?").bind(deviceId).first();
        if (session) {
            return new Response(JSON.stringify({ paired: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ paired: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (request.method === "GET" && url.pathname === "/api/history") {
        const deviceId = url.searchParams.get("deviceId");
        if(!deviceId) return new Response(JSON.stringify({ error: "Missing deviceId" }), { status: 400, headers: corsHeaders });

        const { results: orders } = await env.DB.prepare("SELECT * FROM order_history WHERE device_id = ? ORDER BY timestamp DESC LIMIT 10").bind(deviceId).all();
        
        let formattedOrders = [];
        for (let order of orders) {
             const { results: items } = await env.DB.prepare("SELECT name, price, quantity FROM order_items WHERE order_id = ?").bind(order.id).all();
             formattedOrders.push({
                 id: order.id,
                 date: order.timestamp,
                 storeId: order.store_id,
                 total: order.total,
                 items: items
             });
        }
        return new Response(JSON.stringify(formattedOrders), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/history") {
        const storeId = url.searchParams.get("storeId");
        if(!storeId) return new Response(JSON.stringify({ error: "Missing storeId" }), { status: 400, headers: corsHeaders });

        const { results: orders } = await env.DB.prepare("SELECT * FROM order_history WHERE store_id = ? ORDER BY timestamp DESC LIMIT 50").bind(storeId).all();
        
        let formattedOrders = [];
        for (let order of orders) {
             const { results: items } = await env.DB.prepare("SELECT name, price, quantity FROM order_items WHERE order_id = ?").bind(order.id).all();
             formattedOrders.push({
                 id: order.id,
                 date: order.timestamp,
                 deviceId: order.device_id,
                 total: order.total,
                 items: items
             });
        }
        return new Response(JSON.stringify(formattedOrders), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
}
