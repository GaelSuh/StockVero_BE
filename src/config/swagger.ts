import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';

const routesInSrc = path.join(process.cwd(), 'src', 'routes', '**', '*.ts');
const routesInDist = path.join(process.cwd(), 'dist', 'routes', '**', '*.js');

// Use the same port the server binds on so Swagger "Try it out" requests reach the right address.
const port = process.env.PORT || 4000;

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'StockVero API',
      version: '1.0.0',
    },
    servers: [{ url: `http://localhost:${port}` }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [routesInSrc, routesInDist],
});
