import { invoke } from '@tauri-apps/api/core';
import fs from 'fs';
import path from 'path';

async function runLinkerTests() {
  console.log('🚀 Starting Core Engine Tests...');

  try {
    // 1. Setup paths
    const dictionary = ["Note A", "Note B", "Project X"];
    const dbPath = path.join(process.cwd(), 'linker_test.db');
    const testFile = path.join(process.cwd(), 'test.md');

    console.log(`\n--- Step 1: Initializing Linker ---`);
    await invoke('init_linker', { 
      dbPath, 
      patterns: dictionary 
    });
    console.log('✅ Linker Initialized');

    console.log(`\n--- Step 2: Scanning ${testFile} ---`);
    const links = await invoke('linker_scan', { filePath: testFile });
    console.log('Found links:', links);
    // Expecting Note A, Note B, Project X based on test.md content
    
    console.log(`\n--- Step 3: Diffing ---`);
    const diff = await invoke('linker_diff', { filePath: testFile });
    console.log('Delta:', diff);

    console.log(`\n--- Step 4: Applying Changes ---`);
    const applied = await invoke('linker_apply', { filePath: testFile });
    console.log('Apply result (changes made):', applied);

    console.log(`\n--- Step 5: Verifying Read-Once/No-Op ---`);
    const diff2 = await invoke('linker_diff', { filePath: testFile });
    console.log('Second Diff (should be null/empty):', diff2);
    
    const applied2 = await invoke('linker_apply', { filePath: testFile });
    console.log('Second Apply (should be false):', applied2);

    console.log('\n🎉 All tests completed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
}

runLinkerTests();
