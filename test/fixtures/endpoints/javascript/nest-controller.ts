import { Controller, Get, Post, Put, Delete } from '@nestjs/common';

@Controller('/api/posts')
class PostsController {
    @Get()
    findAll() { return []; }

    @Get(':id')
    findOne() { return {}; }

    @Post()
    create() { return {}; }

    @Put(':id')
    update() { return {}; }

    @Delete(':id')
    remove() { return {}; }
}
