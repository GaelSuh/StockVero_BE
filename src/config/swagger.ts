import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';

const routesInSrc = path.join(process.cwd(), 'src', 'routes', '**', '*.ts');
const routesInDist = path.join(process.cwd(), 'dist', 'routes', '**', '*.js');

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'StockVero API',
      version: '1.0.0',
    },
    // No servers entry: "Try it out" calls whichever address is serving the docs.
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
