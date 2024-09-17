import { Body, Controller, Get, Headers, Post, Req, Res } from '@nestjs/common'

import { AuthService } from './app.service.auth'
import { HeaderParams } from './dtos/requests.dto'
import { Authentication } from './helpers/Authentication'
import { Query } from './helpers/Query'
import { Response } from './helpers/Response'
import { Schema } from './helpers/Schema'
import { DatabaseFindOneOptions, QueryPerform, WhereOperator } from './types/database.types'

@Controller('auth')
export class AuthController {
	constructor(
		private readonly authService: AuthService,
		private readonly authentication: Authentication,
		private readonly query: Query,
		private readonly response: Response,
		private readonly schema: Schema,
	) {}

	/**
	 * Exchange a username and password for an access token
	 */

	@Post('/login')
	login(
		@Body() signInDto: Record<string, any>,
		@Headers() headers: HeaderParams,
	): Promise<{ access_token: string; id: any }> {
		const x_request_id = headers['x-request-id']
		return this.authService.signIn(signInDto.username, signInDto.password, x_request_id)
	}

	/*
	 * Return the current user's profile, useful for testing the access token
	 */

	@Get('/profile')
	async profile(@Req() req, @Res() res, @Headers() headers: HeaderParams): Promise<any> {
		const x_request_id = headers['x-request-id']
		const auth = await this.authentication.auth({ req, x_request_id })
		if (!auth.valid) {
			return res.status(401).send(this.response.text(auth.message))
		}

		//return the user's profile
		const table = this.authentication.getIdentityTable()
		const schema = await this.schema.getSchema({ table, x_request_id })
		const identity_column = await this.authentication.getIdentityColumn(x_request_id)

		const databaseQuery: DatabaseFindOneOptions = {
			schema,
			where: [
				{
					column: identity_column,
					operator: WhereOperator.equals,
					value: auth.user_identifier,
				},
			],
		}

		const user = await this.query.perform(QueryPerform.FIND_ONE, databaseQuery, x_request_id)
		return res.status(200).send(user)
	}
}