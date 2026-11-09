const protectedRoute = (summary: string) => ({
  summary,
  security: [{ bearerAuth: [] }],
  responses: { "200": { description: "Successful response" }, "400": { description: "Validation error" }, "401": { description: "Authentication required" } }
});

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "KoboMarket API",
    version: "1.0.0",
    description: "Marketplace API. All monetary values are integer kobo. Payment and transfer flows use the local mock provider."
  },
  servers: [{ url: "/api/v1" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: {
      Error: {
        type: "object",
        required: ["success", "error"],
        properties: {
          success: { type: "boolean", example: false },
          error: {
            type: "object",
            required: ["code", "message"],
            properties: { code: { type: "string" }, message: { type: "string" }, details: {} }
          }
        }
      },
      Money: { type: "integer", minimum: 0, description: "Amount in integer kobo (₦1 = 100 kobo)" }
    }
  },
  paths: {
    "/health": { get: { summary: "Health check", responses: { "200": { description: "API is available" } } } },
    "/auth/register": { post: { summary: "Register account", responses: { "201": { description: "Account created" } } } },
    "/auth/verify-email": { post: { summary: "Verify email address", responses: { "200": { description: "Email verified" } } } },
    "/auth/login": { post: { summary: "Login", responses: { "200": { description: "Tokens issued" }, "403": { description: "Email not verified" } } } },
    "/auth/refresh": { post: { summary: "Rotate refresh token", responses: { "200": { description: "Tokens rotated" }, "401": { description: "Invalid or reused token" } } } },
    "/auth/logout": { post: protectedRoute("Revoke refresh token or all sessions") },
    "/auth/forgot-password": { post: { summary: "Request password reset", responses: { "200": { description: "Reset instructions queued" } } } },
    "/auth/reset-password": { post: { summary: "Reset password", responses: { "200": { description: "Password updated" } } } },
    "/users/me": { get: protectedRoute("Get current profile"), patch: protectedRoute("Update current profile") },
    "/vendors/apply": { post: protectedRoute("Apply to become a vendor") },
    "/vendors/{id}": { get: { summary: "Get public vendor store", responses: { "200": { description: "Vendor details" } } } },
    "/products": {
      get: { summary: "Search and cursor-page products", responses: { "200": { description: "Product page" } } },
      post: protectedRoute("Create product (approved vendor)")
    },
    "/products/{identifier}": {
      get: { summary: "Get product by slug", responses: { "200": { description: "Product details" } } },
      patch: protectedRoute("Update product by ID"),
      delete: protectedRoute("Soft-delete product by ID")
    },
    "/products/{identifier}/reviews": { post: protectedRoute("Review an eligible completed purchase by product ID") },
    "/cart": { get: protectedRoute("Get cart") },
    "/cart/items": { post: protectedRoute("Add cart item") },
    "/cart/items/{itemId}": { patch: protectedRoute("Update cart item quantity"), delete: protectedRoute("Remove cart item") },
    "/wallet": { get: protectedRoute("Get PostgreSQL wallet balance") },
    "/wallet/transactions": { get: protectedRoute("List wallet ledger entries") },
    "/wallet/fund": { post: protectedRoute("Initialize idempotent wallet funding") },
    "/webhooks/paystack": { post: { summary: "Verify and process funding webhook", responses: { "200": { description: "Webhook processed idempotently" }, "401": { description: "Invalid signature" } } } },
    "/orders/checkout": { post: protectedRoute("Idempotent checkout with stock reservation and escrow") },
    "/orders": { get: protectedRoute("List buyer or vendor orders") },
    "/orders/{id}": { get: protectedRoute("Get authorized order details") },
    "/orders/{id}/cancel": { post: protectedRoute("Cancel order before shipment") },
    "/sub-orders/{id}/ship": { patch: protectedRoute("Vendor ships sub-order") },
    "/sub-orders/{id}/confirm": { patch: protectedRoute("Buyer confirms delivery and completes sub-order") },
    "/sub-orders/{id}/disputes": { post: protectedRoute("Open dispute and freeze escrow") },
    "/disputes": { get: protectedRoute("Admin list disputes") },
    "/disputes/{id}/resolve": { patch: protectedRoute("Resolve dispute with refund or release") },
    "/payouts": { get: protectedRoute("List vendor payouts"), post: protectedRoute("Request idempotent vendor payout") },
    "/notifications": { get: protectedRoute("List notifications") },
    "/notifications/unread-count": { get: protectedRoute("Count unread notifications") },
    "/notifications/read-all": { patch: protectedRoute("Mark all notifications read") },
    "/notifications/{id}/read": { patch: protectedRoute("Mark notification read") },
    "/admin/users": { get: protectedRoute("Search users") },
    "/admin/users/{id}/freeze": { patch: protectedRoute("Freeze or unfreeze account") },
    "/admin/vendors/{id}/approve": { patch: protectedRoute("Approve or reject vendor") },
    "/admin/wallets/{id}/ledger": { get: protectedRoute("Inspect any wallet ledger") },
    "/admin/settings/commission": { patch: protectedRoute("Configure commission basis points") },
    "/admin/reports/revenue": { get: protectedRoute("Revenue by day") },
    "/admin/reports/top-vendors": { get: protectedRoute("Top completed-sales vendors") },
    "/admin/reports/escrow": { get: protectedRoute("Current escrow total") },
    "/admin/reports/reconciliation": { get: protectedRoute("Compare account caches and ledger") }
  }
} as const;
