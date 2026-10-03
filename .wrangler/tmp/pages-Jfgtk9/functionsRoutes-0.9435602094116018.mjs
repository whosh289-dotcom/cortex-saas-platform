import { onRequest as __api___route___js_onRequest } from "/Users/bhaviksakarkar/Documents/Antigravity/project/cortex-saas-platform/functions/api/[[route]].js"

export const routes = [
    {
      routePath: "/api/:route*",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api___route___js_onRequest],
    },
  ]