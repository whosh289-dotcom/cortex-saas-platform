var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// api/[[route]].js
async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    if (request.method === "POST" && url.pathname === "/api/admin/setup") {
      const body = await request.json();
      if (body.storeId && body.stripeKey) {
        await env.DB.prepare("INSERT INTO stores (store_id, stripe_key) VALUES (?, ?) ON CONFLICT(store_id) DO UPDATE SET stripe_key = excluded.stripe_key").bind(body.storeId, body.stripeKey).run();
        return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
      }
      return new Response("Bad Request", { status: 400, headers: corsHeaders });
    }
    if (request.method === "GET" && url.pathname === "/api/admin/catalog") {
      const storeId = url.searchParams.get("storeId");
      if (!storeId) return new Response(JSON.stringify({ error: "Missing storeId" }), { status: 400, headers: corsHeaders });
      const { results } = await env.DB.prepare("SELECT * FROM products WHERE store_id = ?").bind(storeId).all();
      return new Response(JSON.stringify(results), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/catalog") {
      const body = await request.json();
      if (body.storeId && body.barcode && body.name && body.price !== void 0 && body.stock !== void 0) {
        await env.DB.prepare("INSERT INTO products (barcode, store_id, name, price, stock) VALUES (?, ?, ?, ?, ?) ON CONFLICT(barcode, store_id) DO UPDATE SET name = excluded.name, price = excluded.price, stock = excluded.stock").bind(body.barcode, body.storeId, body.name, body.price, body.stock).run();
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
    if (request.method === "POST" && url.pathname === "/api/device/register") {
      const body = await request.json();
      const deviceId = body.deviceId;
      const type = body.type || "unknown";
      if (!deviceId) return new Response(JSON.stringify({ error: "Missing deviceId" }), { status: 400, headers: corsHeaders });
      await env.DB.prepare("INSERT INTO devices (device_id, type) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seen = CURRENT_TIMESTAMP").bind(deviceId, type).run();
      return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
    }
    if (request.method === "GET" && (url.pathname === "/api/cart" || url.pathname.startsWith("/api/cart/"))) {
      let deviceId = url.searchParams.get("deviceId");
      if (!deviceId && url.pathname.startsWith("/api/cart/")) {
        deviceId = url.pathname.replace("/api/cart/", "");
      }
      if (!deviceId) return new Response(JSON.stringify({ error: "Missing deviceId" }), { status: 400, headers: corsHeaders });
      const { results: cartItems } = await env.DB.prepare("SELECT id, barcode, name, price, quantity FROM carts WHERE device_id = ?").bind(deviceId).all();
      let total = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      return new Response(JSON.stringify({ items: cartItems, total }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (request.method === "POST" && url.pathname === "/api/cart/add") {
      const body = await request.json();
      const barcode = body.barcode;
      const deviceId = body.deviceId;
      if (!deviceId || !barcode) return new Response(JSON.stringify({ error: "Missing payload" }), { status: 400, headers: corsHeaders });
      await env.DB.prepare("INSERT INTO devices (device_id, type) VALUES (?, 'display') ON CONFLICT(device_id) DO UPDATE SET last_seen = CURRENT_TIMESTAMP").bind(deviceId).run();
      if (barcode.startsWith("STORE-CHECKIN-")) {
        const remainder = barcode.replace("STORE-CHECKIN-", "");
        const newStoreId = remainder.split("-")[0];
        await env.DB.prepare("INSERT INTO active_sessions (device_id, store_id) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET store_id = excluded.store_id").bind(deviceId, newStoreId).run();
        await env.DB.prepare("DELETE FROM carts WHERE device_id = ?").bind(deviceId).run();
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
        } catch (e) {
        }
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
      let total = cartItems.reduce((sum, item) => sum + (item.price || 0) * item.quantity, 0);
      return new Response(JSON.stringify({ status: "success", productName: product.name, price: product.price ? product.price.toFixed(2) : "0.00", cartTotal: total }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (request.method === "POST" && url.pathname === "/api/cart/update") {
      const body = await request.json();
      const { cartId, quantity, deviceId } = body;
      if (!cartId || quantity === void 0) return new Response(JSON.stringify({ error: "Missing payload" }), { status: 400, headers: corsHeaders });
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
      if (!deviceId) return new Response(JSON.stringify({ error: "Missing deviceId" }), { status: 400, headers: corsHeaders });
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
      stripeParams.append("success_url", `${url.origin}/cart.html?success=true`);
      stripeParams.append("cancel_url", `${url.origin}/cart.html?canceled=true`);
      stripeParams.append("mode", "payment");
      cartItems.forEach((item, index) => {
        stripeParams.append(`line_items[${index}][price_data][currency]`, "usd");
        stripeParams.append(`line_items[${index}][price_data][product_data][name]`, item.name);
        stripeParams.append(`line_items[${index}][price_data][unit_amount]`, Math.round((item.price || 0) * 100));
        stripeParams.append(`line_items[${index}][quantity]`, item.quantity);
      });
      const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${storeStripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded"
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
      if (!deviceId) return new Response(JSON.stringify({ error: "Missing deviceId" }), { status: 400, headers: corsHeaders });
      const { results: cartItems } = await env.DB.prepare("SELECT barcode, name, price, quantity FROM carts WHERE device_id = ?").bind(deviceId).all();
      if (cartItems.length > 0) {
        let total = cartItems.reduce((sum, item) => sum + (item.price || 0) * item.quantity, 0);
        const session = await env.DB.prepare("SELECT store_id FROM active_sessions WHERE device_id = ?").bind(deviceId).first();
        const storeId = session ? session.store_id : "unknown";
        await env.DB.prepare("INSERT INTO order_history (device_id, store_id, total) VALUES (?, ?, ?)").bind(deviceId, storeId, total).run();
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
      if (!body.deviceId) return new Response("Missing deviceId", { status: 400, headers: corsHeaders });
      await env.DB.prepare("INSERT OR REPLACE INTO active_sessions (device_id, store_id) VALUES (?, 'PENDING')").bind(body.deviceId).run();
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (request.method === "GET" && url.pathname === "/api/band/status") {
      const deviceId = url.searchParams.get("deviceId");
      if (!deviceId) return new Response("Missing deviceId", { status: 400, headers: corsHeaders });
      const session = await env.DB.prepare("SELECT store_id FROM active_sessions WHERE device_id = ?").bind(deviceId).first();
      if (session) {
        return new Response(JSON.stringify({ paired: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ paired: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (request.method === "GET" && url.pathname === "/api/history") {
      const deviceId = url.searchParams.get("deviceId");
      if (!deviceId) return new Response(JSON.stringify({ error: "Missing deviceId" }), { status: 400, headers: corsHeaders });
      const { results: orders } = await env.DB.prepare("SELECT * FROM order_history WHERE device_id = ? ORDER BY timestamp DESC LIMIT 10").bind(deviceId).all();
      let formattedOrders = [];
      for (let order of orders) {
        const { results: items } = await env.DB.prepare("SELECT name, price, quantity FROM order_items WHERE order_id = ?").bind(order.id).all();
        formattedOrders.push({
          id: order.id,
          date: order.timestamp,
          storeId: order.store_id,
          total: order.total,
          items
        });
      }
      return new Response(JSON.stringify(formattedOrders), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (request.method === "GET" && url.pathname === "/api/admin/history") {
      const storeId = url.searchParams.get("storeId");
      if (!storeId) return new Response(JSON.stringify({ error: "Missing storeId" }), { status: 400, headers: corsHeaders });
      const { results: orders } = await env.DB.prepare("SELECT * FROM order_history WHERE store_id = ? ORDER BY timestamp DESC LIMIT 50").bind(storeId).all();
      let formattedOrders = [];
      for (let order of orders) {
        const { results: items } = await env.DB.prepare("SELECT name, price, quantity FROM order_items WHERE order_id = ?").bind(order.id).all();
        formattedOrders.push({
          id: order.id,
          date: order.timestamp,
          deviceId: order.device_id,
          total: order.total,
          items
        });
      }
      return new Response(JSON.stringify(formattedOrders), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
}
__name(onRequest, "onRequest");

// ../.wrangler/tmp/pages-jt3ldE/functionsRoutes-0.2906239522510745.mjs
var routes = [
  {
    routePath: "/api/:route*",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest]
  }
];

// ../../../../../../../private/var/folders/rz/05kxggpj1p78mkqd879c84br0000gn/T/bunx-501-wrangler@latest/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../../../../../private/var/folders/rz/05kxggpj1p78mkqd879c84br0000gn/T/bunx-501-wrangler@latest/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};
