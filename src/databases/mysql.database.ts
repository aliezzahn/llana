import * as mysql from 'mysql2/promise'
import { Connection } from 'mysql2/promise'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Logger } from '../helpers/Logger'
import {
	DatabaseFindManyOptions,
	DatabaseFindOneOptions,
	DatabaseFindTotalRecords,
	DatabaseSchema,
	DatabaseSchemaColumn,
	DatabaseSchemaRelation,
	DatabaseWhere,
	WhereOperator,
} from '../types/database.types'
import { ListResponseObject } from '../types/response.types'
import { Pagination } from '../helpers/Pagination'
import { SortCondition } from 'src/types/schema.types'

@Injectable()
export class MySQL {
	constructor(
		private readonly configService: ConfigService,
		private readonly logger: Logger,
		private readonly pagination: Pagination,
	) {}

	/**
	 * Create a MySQL connection
	 */
	async createConnection(): Promise<Connection> {
		if (!mysql) {
			throw new Error('MySQL library is not initialized')
		}
		return await mysql.createConnection(this.configService.get('database.host'))
	}

	async performQuery(query: string): Promise<any> {
		const connection = await this.createConnection()
		try {
			const [results] = await connection.query<any[]>(query)
			connection.end()
			return results
		} catch (e) {
			this.logger.error('Error executing mysql database query')
			this.logger.error({
				sql: query,
				error: {
					message: e.message,
				},
			})
			connection.end()
			throw new Error(e)
		}
	}

	/**
	 * Get Table Schema
	 * @param repository
	 * @param table_name
	 */

	async getSchema(table_name: string): Promise<DatabaseSchema> {
		const columns_result = await this.performQuery(`DESCRIBE ${table_name}`)

		const columns = columns_result.map((column: any) => {
			return <DatabaseSchemaColumn>{
				field: column.Field,
				type: column.Type,
				nullable: column.Null === 'YES',
				required: column.Null === 'NO',
				primary_key: column.Key === 'PRI',
				unique_key: column.Key === 'UNI',
				foreign_key: column.Key === 'MUL',
				default: column.Default,
				extra: column.Extra,
			}
		})

		const relations_query = `SELECT TABLE_NAME as 'table', COLUMN_NAME as 'column', REFERENCED_TABLE_NAME as 'org_table', REFERENCED_COLUMN_NAME as 'org_column' FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME = '${table_name}';`
		const relations_result = await this.performQuery(relations_query)
		const relations = relations_result
			.filter((row: DatabaseSchemaRelation) => row.table !== null)
			.map((row: DatabaseSchemaRelation) => row)

		const relation_back_query = `SELECT REFERENCED_TABLE_NAME as 'table', REFERENCED_COLUMN_NAME as 'column', TABLE_NAME as 'org_table', COLUMN_NAME as 'org_column' FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_NAME = '${table_name}' AND REFERENCED_TABLE_NAME IS NOT NULL;`
		const relation_back_result = await this.performQuery(relation_back_query)
		const relation_back = relation_back_result
			.filter((row: DatabaseSchemaRelation) => row.table !== null)
			.map((row: DatabaseSchemaRelation) => row)

		relations.push(...relation_back)

		return {
			table: table_name,
			primary_key: columns.find(column => column.primary_key).field,
			columns,
			relations,
		}
	}

	/**
	 * Find single record
	 */

	async findOne(options: DatabaseFindOneOptions): Promise<any> {
		let command = this.find(options)
		command += ` LIMIT 1`

		this.logger.debug(`[Query][Find][One][${options.schema.table}] ` + command)

		const results = await this.performQuery(command)

		if (!options.joins) {
			return await this.addRelations(options, results[0])
		} else {
			return results[0]
		}
	}

	/**
	 * Find multiple records
	 */

	async findMany(options: DatabaseFindManyOptions): Promise<ListResponseObject> {
		const total = await this.findTotalRecords(options)

		let command = this.find(options)

		let sort: SortCondition[] = []
		if (options.sort) {
			sort = options.sort?.filter(sort => !sort.column.includes('.'))
		}

		if (sort?.length) {
			command += `ORDER BY ${sort.map(sort => `${sort.column} ${sort.operator}`).join(', ')}`
		}

		if (!options.limit) {
			options.limit = this.configService.get<number>('database.defaults.limit') ?? 20
		}

		if (!options.offset) {
			options.offset = 0
		}

		command += ` LIMIT ${options.limit} OFFSET ${options.offset}`

		this.logger.debug(`[Query][Find][Many][${options.schema.table}] ` + command)

		const results = await this.performQuery(command)

		for (const r in results) {
			results[r] = await this.addRelations(options, results[r])
		}

		return {
			limit: options.limit,
			offset: options.offset,
			total,
			pagination: {
				total: results.length,
				page: {
					current: this.pagination.current(options.limit, options.offset),
					prev: this.pagination.previous(options.limit, options.offset),
					next: this.pagination.next(options.limit, options.offset, total),
					first: this.pagination.first(options.limit),
					last: this.pagination.last(options.limit, total),
				},
			},
			data: results,
		}
	}

	find(options: DatabaseFindOneOptions | DatabaseFindManyOptions): string {
		const table_name = options.schema.table

		const fields = options.joins ? options.fields : options.fields?.filter(field => !field.includes('.'))
		const where = options.joins ? options.where : options.where?.filter(where => !where.column.includes('.'))

		for (const f in fields) {
			if (!fields[f].includes('.')) {
				fields[f] = `${table_name}.` + fields[f]
			}
		}

		let command = `SELECT ${fields?.length ? fields.join(`, `) : '*'} `
		command += `FROM ${table_name} `

		if (options.joins && options.relations?.length) {
			for (const relation of options.relations) {
				const schema_relation = options.schema.relations.find(r => r.table === relation)
				command += `LEFT JOIN ${schema_relation.table} ON ${schema_relation.org_table}.${schema_relation.org_column} = ${schema_relation.table}.${schema_relation.column} `
			}
		}

		if (where?.length) {
			command += `WHERE ${where.map(w => `${w.column.includes('.') ? w.column : table_name + '.' + w.column} ${w.operator === WhereOperator.search ? 'LIKE' : w.operator} ${w.value ? `'` + (w.operator === WhereOperator.search ? '%' : '') + w.value + (w.operator === WhereOperator.search ? '%' : '') + `'` : ''}`).join(' AND ')} `
		}

		return command
	}

	/**
	 * Get total records with where conditions
	 */

	async findTotalRecords(options: DatabaseFindTotalRecords): Promise<number> {
		const table_name = options.schema.table

		let command = `SELECT COUNT(*) as total FROM ${table_name} `

		const where = options.where?.filter(where => !where.column.includes('.'))

		if (where?.length) {
			command += `WHERE ${where.map(w => `${w.column} ${w.operator === WhereOperator.search ? 'LIKE' : w.operator} ${w.value ? `'` + (w.operator === WhereOperator.search ? '%' : '') + w.value + (w.operator === WhereOperator.search ? '%' : '') + `'` : ''}`).join(' AND ')} `
		}

		const results = await this.performQuery(command)
		return results[0].total
	}

	async addRelations(options: DatabaseFindOneOptions | DatabaseFindManyOptions, result: any): Promise<any> {
		if (!result) return {}

		if (options.relations?.length) {
			for (const relation of options.relations) {
				const schema_relation = options.schema.relations.find(r => r.table === relation).schema
				const relation_table = options.schema.relations.find(r => r.table === relation)
				const fields = options.fields?.filter(field => field.includes(schema_relation.table + '.'))

				if (fields.length) {
					fields.forEach((field, index) => {
						fields[index] = field.replace(`${schema_relation.table}.`, '')
					})
				}

				if (!fields.length) {
					fields.push(...schema_relation.columns.map(column => column.field))
				}

				const limit = this.configService.get<number>('database.defaults.relations.limit')

				let where: DatabaseWhere[] = [
					{
						column: relation_table.column,
						operator: WhereOperator.equals,
						value: result[relation_table.org_column],
					},
				]

				if ('where' in options && options.where) {
					where = where.concat(
						options.where?.filter(where => where.column.includes(schema_relation.table + '.')),
					)

					for (const w of where) {
						w.column = w.column.replace(`${schema_relation.table}.`, '')
					}
				}

				let sort: SortCondition[] = []
				if ('sort' in options && options.sort) {
					sort = options.sort?.filter(sort => sort.column.includes(schema_relation.table + '.'))
					for (const s of sort) {
						s.column = s.column.replace(`${schema_relation.table}.`, '')
					}
				}

				this.logger.debug(`[Query][Find][Many][${options.schema.table}][Relation][${relation}]`, {
					fields,
					where,
					sort,
					limit,
					offset: 0,
				})

				const relation_result = await this.findMany({
					schema: schema_relation,
					fields,
					where,
					sort,
					limit,
					offset: 0,
				})

				result[relation] = relation_result.data
			}
		}
		return result
	}
}