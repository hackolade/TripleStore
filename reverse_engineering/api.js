'use strict';

const { dependencies, setDependencies } = require('./appDependencies');
const snippetsPath = '../snippets/';
const logHelper = require('./logHelper');
let _;
let async;
const neo4j = {};

const snippets = {
	'Cartesian 3D': require(snippetsPath + 'cartesian-3d.json'),
	'Cartesian': require(snippetsPath + 'cartesian.json'),
	'WGS-84-3D': require(snippetsPath + 'point-wgs-84-3d.json'),
	'WGS-84': require(snippetsPath + 'point-wgs-84.json'),
};

module.exports = {
	connect: function (connectionInfo, logger, cb, app) {
		initDependencies(app);
	},

	disconnect: function (connectionInfo, cb) {
		cb();
	},

	testConnection: function (connectionInfo, logger, cb, app) {
		logInfo('Test connection', connectionInfo, logger);

		initDependencies(app);
		this.connect(
			connectionInfo,
			logger,
			error => {
				this.disconnect(connectionInfo, () => {});
				cb(error);
			},
			app,
		);
	},

	getDatabases: function (connectionInfo, logger, cb) {
		cb();
	},

	getDocumentKinds: function (connectionInfo, logger, cb) {
		cb();
	},

	getDbCollectionsNames: async function (connectionInfo, logger, cb, app) {
		cb();
	},

	getDbCollectionsData: async function (data, logger, cb, app) {
		cb();
	},

	getDbCollectionsDataWrapped: async function (data, logger, cb, app) {
		cb();
	},
};

const initDependencies = app => {
	setDependencies(app);
	_ = dependencies.lodash;
	async = dependencies.async;
};

const getCount = (count, recordSamplingSettings) => {
	const per = recordSamplingSettings.relative.value;
	const size =
		recordSamplingSettings.active === 'absolute'
			? recordSamplingSettings.absolute.value
			: Math.round((count / 100) * per);
	return size;
};

const isEmptyLabel = documents => {
	if (!Array.isArray(documents)) {
		return true;
	}

	return documents.reduce((result, doc) => result && _.isEmpty(doc), true);
};

const getTemplate = documents => {
	return documents.reduce((tpl, doc) => _.merge(tpl, doc), {});
};

const checkConnection = logger => (host, port) => {
	return logHelper.checkConnection(host, port).then(
		() => {
			logger.log('info', 'Socket ' + host + ':' + port + ' is available.', 'Host availability');
		},
		error => {
			const errorMessage = 'Socket ' + host + ':' + port + ' is not available.';
			logger.log('error', prepareError(error), errorMessage, 'Host availability');
			throw new Error(errorMessage);
		},
	);
};

const logInfo = (step, connectionInfo, logger) => {
	logger.clear();
	logger.log('info', logHelper.getSystemInfo(connectionInfo.appVersion), step);
	logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);
};

const getNodesData = (dbName, labels, isMultiDb, data, logger) => {
	return new Promise((resolve, reject) => {
		let packages = [];
		async.map(
			labels,
			(labelName, nextLabel) => {
				logger(labelName, 'Getting data...');

				neo4j
					.getNodesCount(labelName, dbName, isMultiDb)
					.then(quantity => {
						const count = getCount(quantity, data.recordSamplingSettings);
						logger(labelName, 'Found ' + count + ' nodes');

						return neo4j.getNodes(labelName, count, dbName, isMultiDb);
					})
					.then(documents => {
						logger(labelName, 'Data has successfully got');

						const packageData = getLabelPackage(
							dbName,
							labelName,
							documents,
							data.includeEmptyCollection,
							data.fieldInference,
							data.indexes[labelName],
							data.constraints[labelName],
						);
						if (packageData) {
							packages.push(packageData);
						}
						nextLabel(null);
					})
					.catch(nextLabel);
			},
			err => {
				if (err) {
					reject(err);
				} else {
					resolve(packages);
				}
			},
		);
	});
};

const getRelationshipData = (
	schema,
	dbName,
	dbVersion,
	recordSamplingSettings,
	fieldInference,
	metaData,
	isMultiDb,
) => {
	const { constraints, indexes } = metaData;
	return new Promise((resolve, reject) => {
		async.map(
			schema,
			(chain, nextChain) => {
				neo4j
					.getCountRelationshipsData(chain.start, chain.relationship, chain.end, dbName, isMultiDb)
					.then(quantity => {
						const count = getCount(quantity, recordSamplingSettings);
						return neo4j.getRelationshipData(
							chain.start,
							chain.relationship,
							chain.end,
							count,
							dbName,
							isMultiDb,
						);
					})
					.then(rawDocuments => {
						const documents = deserializeData(rawDocuments);
						const separatedConstraints = separateConstraintsByType(constraints[chain.relationship] || []);
						const jsonSchema = createSchemaByConstraints(documents, separatedConstraints);
						let packageData = {
							dbName,
							parentCollection: chain.start,
							relationshipName: chain.relationship,
							childCollection: chain.end,
							validation: {
								jsonSchema,
							},
							documents,
						};

						if (fieldInference.active === 'field') {
							packageData.documentTemplate = getTemplate(documents);
						}

						if (dbVersion === '4.3') {
							packageData.relationshipInfo = { index: indexes[chain.relationship] || [] };
						}

						nextChain(null, packageData);
					})
					.catch(nextChain);
			},
			(err, packages) => {
				if (err) {
					reject(err);
				} else {
					resolve(packages);
				}
			},
		);
	});
};

const getLabelPackage = (
	dbName,
	labelName,
	rawDocuments,
	includeEmptyCollection,
	fieldInference,
	indexes,
	constraints,
) => {
	const documents = deserializeData(rawDocuments);
	const separatedConstraints = separateConstraintsByType(constraints);
	const jsonSchema = createSchemaByConstraints(documents, separatedConstraints);
	let packageData = {
		dbName: dbName,
		collectionName: labelName,
		documents,
		indexes: [],
		bucketIndexes: [],
		views: [],
		validation: { jsonSchema },
		emptyBucket: false,
		bucketInfo: {},
		entityLevel: {
			constraint: separatedConstraints['NODE_KEY'],
			index: indexes,
		},
	};

	if (fieldInference.active === 'field') {
		packageData.documentTemplate = getTemplate(documents);
	}

	if (includeEmptyCollection || !isEmptyLabel(documents)) {
		return packageData;
	} else {
		return null;
	}
};

const prepareIndexes3x = indexes => {
	const hasProperties = /INDEX\s+ON\s+\:(.*)\((.*)\)/i;
	let map = {};

	indexes.forEach((index, i) => {
		if (index.properties) {
			index.properties = index.properties;
		} else if (hasProperties.test(index.description)) {
			let parsedDescription = index.description.match(hasProperties);
			index.label = parsedDescription[1];
			index.properties = parsedDescription[2].split(',').map(s => s.trim());
		} else {
			index.properties = [];
		}

		if (!map[index.label]) {
			map[index.label] = [];
		}

		map[index.label].push({
			name: `${index.label}.[${index.properties.join(',')}]`,
			key: index.properties,
			state: index.state,
			type: index.type,
			provider: JSON.stringify(index.provider, null, 4),
		});
	});

	return map;
};

const prepareIndexes4x = indexes => {
	let map = {};
	indexes.forEach((index, i) => {
		index.properties = index.properties || [];

		const index_obj = {
			name: index.name,
			key: index.properties,
			state: index.state,
			type: index.type,
			uniqueness: index.uniqueness === 'UNIQUE',
			provider: index.provider,
		};

		index.labelsOrTypes.forEach((label, i) => {
			if (!map[label]) {
				map[label] = [index_obj];
			} else {
				map[label].push(index_obj);
			}
		});
	});
	return map;
};

const prepareConstraints = constraints => {
	const isUnique = /^constraint\s+on\s+\([\s\S]+\:([\S\s]+)\s*\)\s+assert\s+[\s\S]+\.([\s\S]+)\s*\)\s+IS\s+UNIQUE/i;
	const isNodeKey =
		/^constraint\s+on\s+\([\s\S]+\:\s*([\S\s]+)\s*\)\s+assert\s+(?:\(\s*([\s\S]+)\s*\)|[\s\S]+\.\s*([\S\s]+)\s*)\s+IS\s+NODE\s+KEY/i;
	const isExists = /^constraint\s+on\s+\([\s\S]+\:([\s\S]+)\s*\)\s+assert\s+exists\([\s\S]+\.([\s\S]+)\s*\)/i;
	let result = {};
	const addToResult = (result, name, label, key, type, keyName = 'key') => {
		const labelName = label.trim();
		if (!result[labelName]) {
			result[labelName] = [];
		}

		result[labelName].push({ [keyName]: key, name, type });
	};

	constraints.forEach(c => {
		const constraint = c.description.trim();

		if (isUnique.test(constraint)) {
			let data = constraint.match(isUnique);
			let label = data[1];
			let field = data[2];

			addToResult(result, `Unique ${label}.${field}`, label, [field], 'UNIQUE');
		} else if (isExists.test(constraint)) {
			let data = constraint.match(isExists);
			let label = data[1];
			let field = data[2];

			addToResult(result, `Required ${label}.${field}`, label, [field], 'EXISTS');
		} else if (isNodeKey.test(constraint)) {
			let data = constraint.match(isNodeKey);
			let label = data[1];
			let fields = [];

			if (data[2]) {
				fields = data[2].split(',').map(s => {
					const field = s.trim().match(/[\s\S]+\.([\s\S]+)/);

					if (field) {
						return field[1].trim();
					} else {
						return s;
					}
				});
			} else if (data[3]) {
				fields = [data[3].trim()];
			}

			if (fields.length) {
				addToResult(result, `${label}`, label, fields, 'NODE_KEY', 'compositeNodeKey');
			}
		}
	});

	return result;
};

const prepareError = error => {
	return {
		message: error.message,
		stack: error.stack,
	};
};

const deserializeData = documents => {
	const deserializeObject = value => {
		try {
			return JSON.parse(value);
		} catch (e) {
			return value;
		}
	};
	const handleField = value => {
		if (typeof value === 'string') {
			return deserializeObject(value);
		} else if (Array.isArray(value)) {
			return value.map(handleField);
		} else {
			return value;
		}
	};
	const deserializator = document => {
		let newDocument = {};

		for (let field in document) {
			newDocument[field] = handleField(document[field]);
		}

		return newDocument;
	};

	return Array.isArray(documents)
		? documents.map(document => (typeof document === 'object' ? deserializator(document) : {}))
		: [];
};

const createSchemaByConstraints = (documents, constraints) => {
	let jsonSchema = constraints['EXISTS'].reduce(
		(jsonSchema, constraint) => {
			jsonSchema.required = jsonSchema.required.concat(constraint.key);
			return jsonSchema;
		},
		{ required: [], properties: {} },
	);
	jsonSchema = constraints['UNIQUE'].reduce((jsonSchema, constraint) => {
		return constraint.key.reduce((jsonSchema, key) => {
			if (!jsonSchema.properties[key]) {
				jsonSchema.properties[key] = {};
			}
			jsonSchema.properties[key].unique = true;
			return jsonSchema;
		}, jsonSchema);
	}, jsonSchema);

	documents.forEach(document => setDocumentInSchema(document, jsonSchema));

	return jsonSchema;
};

const setDocumentInSchema = (document, jsonSchema) => {
	const has = Function.prototype.call.bind(Object.prototype.hasOwnProperty);

	Object.keys(document).forEach(fieldName => {
		const value = document[fieldName];

		if (Array.isArray(value)) {
			const items = getSchemaArrayItems(value);
			if (items.length) {
				if (!has(jsonSchema.properties || {}, fieldName)) {
					jsonSchema.properties[fieldName] = {
						type: 'list',
						items,
					};
				}
			}
		} else if (Object(value) === value) {
			if (!has(jsonSchema.properties || {}, fieldName)) {
				if (value.srid) {
					jsonSchema.properties[fieldName] = getSchemaSpatialType(value);
				} else if (neo4j.isTemporalTypeField(value)) {
					jsonSchema.properties[fieldName] = neo4j.getTemporalFieldSchema(value);
					if (typeof document[fieldName]?.toString === 'function') {
						document[fieldName] = document[fieldName].toString();
					}
				} else {
					jsonSchema.properties[fieldName] = setDocumentInSchema(value, { properties: {} });
				}
			}
			if (value.srid) {
				delete document[fieldName];
			}
		} else if (typeof value === 'number') {
			if (!has(jsonSchema.properties || {}, fieldName)) {
				jsonSchema.properties[fieldName] = {
					type: 'number',
					mode: value % 1 === 0 ? 'integer' : 'float',
					sample: value,
				};
			}
		}
	});

	return jsonSchema;
};

const getSchemaArrayItems = arrValue => {
	const items = [];
	let ofs = 0;

	[...arrValue].forEach((item, i) => {
		if (_.isPlainObject(item) && item.srid) {
			items.push(getSchemaSpatialType(item));
			arrValue.splice(i - ofs, 1);
			ofs++;
		} else if (Array.isArray(item)) {
			items.push({
				type: 'list',
				items: getSchemaArrayItems(item),
			});
		} else if (typeof item === 'number') {
			items.push({
				type: 'number',
				mode: item % 1 === 0 ? 'integer' : 'float',
				sample: item,
			});
			arrValue.splice(i - ofs, 1);
			ofs++;
		}
	});

	return items;
};

const getSchemaSpatialType = value => {
	switch (Number(value.srid)) {
		case 4326:
			return {
				type: 'spatial',
				mode: 'point',
				subType: 'WGS-84',
				properties: getSnippetPropertiesByName('WGS-84'),
			};
		case 4979:
			return {
				type: 'spatial',
				mode: 'point',
				subType: 'WGS-84-3D',
				properties: getSnippetPropertiesByName('WGS-84-3D'),
			};
		case 7203:
			return {
				type: 'spatial',
				mode: 'point',
				subType: 'Cartesian',
				properties: getSnippetPropertiesByName('Cartesian'),
			};
		case 9157:
			return {
				type: 'spatial',
				mode: 'point',
				subType: 'Cartesian 3D',
				properties: getSnippetPropertiesByName('Cartesian 3D'),
			};
	}
};

const getSnippetPropertiesByName = name => {
	const snippet = snippets[name] || snippets['WGS-84'];
	const properties = {};

	snippet.properties.forEach(fieldSchema => {
		properties[fieldSchema.name] = Object.assign({}, fieldSchema);
		delete properties[fieldSchema.name].name;
	});

	return properties;
};

const separateConstraintsByType = (constraints = []) => {
	return constraints.reduce(
		(result, constraint) => {
			constraint = Object.assign({}, constraint);
			const type = constraint.type;
			delete constraint.type;
			result[type].push(constraint);

			return result;
		},
		{ 'UNIQUE': [], 'EXISTS': [], 'NODE_KEY': [] },
	);
};
