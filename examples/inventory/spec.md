# Inventory check

POST /inventory/check accepts a SKU and a positive integer quantity.
Use stock.json as the complete inventory snapshot. For a known SKU, return HTTP
200 with the requested sku, available count, and fulfillable set to whether
available >= quantity. Zero stock is still a known SKU. For an unknown SKU,
return HTTP 404 with {"error":"unknown_sku"}. This operation does not reserve,
create, or decrement inventory. Every request uses the same snapshot.
If the inventory database is unavailable, return HTTP 503 with
{"error":"inventory_unavailable"}.
