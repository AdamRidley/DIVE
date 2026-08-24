#!/usr/bin/env node
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const schemaPath = resolve(projectRoot, 'schemas/story.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({
  allErrors: true,
  strict: false, // Allow additional properties (keeps existing stories valid)
  validateSchema: false, // Avoid meta-schema loading issues
  allowUnionTypes: true,
});
addFormats(ajv);

const validate = ajv.compile(schema);

const defaultFiles = [
  resolve(projectRoot, 'public/story.json'),
  resolve(projectRoot, 'examples/the_wealth_and_health_of_nations/story.json'),
];

const files = process.argv.slice(2).length > 0 
  ? process.argv.slice(2).map(f => resolve(process.cwd(), f))
  : defaultFiles;

let hasErrors = false;

console.log('🔍 DIVE Story JSON Validator\n');

for (const file of files) {
  try {
    const content = readFileSync(file, 'utf8');
    const data = JSON.parse(content);
    
    const valid = validate(data);
    
    if (!valid) {
      console.error(`❌ ${file}`);
      for (const err of validate.errors || []) {
        const path = err.instancePath || '/';
        console.error(`   ${path}: ${err.message}`);
        if (err.params && err.params.allowedValues) {
          console.error(`   Allowed values: ${err.params.allowedValues.join(', ')}`);
        }
      }
      console.error('');
      hasErrors = true;
    } else {
      console.log(`✅ ${file}`);
    }
  } catch (err) {
    console.error(`❌ ${file}: ${err.message}`);
    hasErrors = true;
  }
}

if (hasErrors) {
  console.error('\n❌ Story validation failed. Please fix the errors above.');
  process.exit(1);
} else {
  console.log('\n✅ All stories validated successfully! 🎉');
  process.exit(0);
}
