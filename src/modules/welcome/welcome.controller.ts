import { Get, Controller, Render } from '@nestjs/common';

@Controller()
export class WelcomeController {
  @Get()
  @Render('welcome')
  root() {
    return {
       //message: 'Hello world!' 
      };
  }
}