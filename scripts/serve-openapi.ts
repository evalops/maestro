import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const specPath = resolve(process.cwd(), "openapi.json");
const spec = readFileSync(specPath, "utf8");

const html = `<!doctype html>
<html>
  <head>
    <title>Composer OpenAPI</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
    <script>
      window.onload = () => {
        SwaggerUIBundle({
          spec: ${JSON.stringify(JSON.parse(spec))},
          dom_id: '#swagger-ui',
        });
      };
    </script>
  </body>
</html>`;

const port = Number.parseInt(process.env.PORT || "9090", 10);

createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}).listen(port, () => {
  console.log(`Swagger UI available at http://localhost:${port}`);
});
