import { Controller } from '@nestjs/common';

// Root controller — no routes needed here.
// All API routes are mounted under /v1/ via their feature modules.
@Controller()
export class AppController {}
