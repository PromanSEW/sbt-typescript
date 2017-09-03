/* global process, require */
/// <reference path="./internal.ts" />
import {
    Program,
    Diagnostic,
    SourceFile,
    CompilerOptions,
    DiagnosticCategory,
    EmitResult,
    convertCompilerOptionsFromJson,
    createProgram,
    createCompilerHost,
    getPreEmitDiagnostics,
    flattenDiagnosticMessageText,
    sys
} from "typescript"
import * as fs from "fs-extra"

const args: Args = parseArgs(process.argv)
const sbtTypescriptOpts: SbtTypescriptOptions = args.options

const logger = new Logger(sbtTypescriptOpts.logLevel)

const sourceMappings = new SourceMappings(args.sourceFileMappings)

logger.debug("starting compilation of ", sourceMappings.mappings.map((sm) => sm.relativePath))
logger.debug("from ", sbtTypescriptOpts.assetsDirs)
logger.debug("to ", args.target)
logger.debug("args "+ JSON.stringify( args,null,2))

const compileResult = compile(sourceMappings, sbtTypescriptOpts, args.target)

compileDone(compileResult)

function compile(sourceMaps: SourceMappings, sbtOptions: SbtTypescriptOptions, target: string): CompilationResult {
    const problems: Problem[] = []
    let results: CompilationFileResult[] = []

    const {options: compilerOptions, errors} = toCompilerOptions(sbtOptions)

    if (errors.length > 0) {
        problems.push(...toProblems(errors, sbtOptions.tsCodesToIgnore))
    }
    else {
        compilerOptions.outDir = target

        let nodeModulesPaths: string[] = []
        if (sbtOptions.resolveFromNodeModulesDir) {
            nodeModulesPaths = nodeModulesPaths.concat(sbtOptions.nodeModulesDirs.map(p => p + "/*"))
            nodeModulesPaths = nodeModulesPaths.concat(sbtOptions.nodeModulesDirs.map(p => p + "/@types/*"))
            compilerOptions.typeRoots = sbtOptions.nodeModulesDirs.map(p => p + "/@types")
        }

        const assetPaths = sbtOptions.assetsDirs.map(p => p + "/*")
        // see https://github.com/Microsoft/TypeScript-Handbook/blob/release-2.0/pages/Module%20Resolution.md#path-mapping
        compilerOptions.baseUrl = "."
        compilerOptions.paths = {
            "*": ["*"].concat(nodeModulesPaths)//.concat(assetPaths)
        }
        logger.debug("using tsc options ", compilerOptions)
        const compilerHost = createCompilerHost(compilerOptions)

        let filesToCompile = sourceMaps.asAbsolutePaths()
        if (sbtOptions.extraFiles) filesToCompile = filesToCompile.concat(sbtOptions.extraFiles)

        logger.debug("files to compile ", filesToCompile)
        const program: Program = createProgram(filesToCompile, compilerOptions, compilerHost)
        logger.debug("created program")
        problems.push(...findPreemitProblems(program, sbtOptions.tsCodesToIgnore))

        const emitOutput = program.emit()

        const moveTestPromise =sbtOptions.assetsDirs.length === 2 ? moveEmittedTestAssets(sbtOptions) : Promise.resolve({})


        moveTestPromise
            .then((value)=>{
                if (sbtOptions.assertCompilation) {
                    logAndAssertEmitted(results, emitOutput)
                }

            },(e)=>{

            })
        problems.push(...toProblems(emitOutput.diagnostics, sbtOptions.tsCodesToIgnore))

        if (logger.isDebug) {
            const declarationFiles = program.getSourceFiles().filter(isDeclarationFile)
            logger.debug("referring to " + declarationFiles.length + " declaration files and " + (program.getSourceFiles().length - declarationFiles.length) + " code files.")
        }

        if (!emitOutput.emitSkipped) {
            results = flatten(program.getSourceFiles().filter(isCodeFile).map(toCompilationResult(sourceMaps, compilerOptions)))
        } else {
            results = []
        }

    }

    const output = <CompilationResult>{
        results: results,
        problems: problems
    }
    return output

    function logAndAssertEmitted(declaredResults: CompilationFileResult[], emitOutput: EmitResult) {
        const ffw = flatFilesWritten(declaredResults)
        const emitted = emitOutput.emitSkipped ? [] : emitOutput.emittedFiles
        logger.debug("files written", ffw)
        logger.debug("files emitted", emitted)

        const emittedButNotDeclared = minus(emitted, ffw)
        const declaredButNotEmitted = minus(ffw, emitted)

        notExistingFiles(ffw)
            .then(nef => {
                if (nef.length > 0) {
                    logger.error(`files declared that have not been generated ${nef}`)
                } else {
                    logger.debug(`all declared files exist`)
                }

            })
            .catch(err => logger.error("unexpected error", err))

        if (emittedButNotDeclared.length > 0 || declaredButNotEmitted.length > 0) {
            const errorMessage = `
emitted and declared files are not equal
emitted but not declared ${emittedButNotDeclared}
declared but not emitted ${declaredButNotEmitted}
`
            if (!emitOutput.emitSkipped) logger.error(errorMessage)//throw new Error(errorMessage)
        }

        return
        function minus(arr1: string[], arr2: string[]): string[] {
            const r: string[] = []
            for (let s of arr1) {
                if (arr2.indexOf(s) == -1) {
                    r.push(s)
                }
            }
            return r
        }
    }

    function moveEmittedTestAssets(sbtOpts: SbtTypescriptOptions):Promise<any> {
        // we're compiling testassets
        // unfortunately because we have two rootdirs the paths are not being relativized to outDir
        // see https://github.com/Microsoft/TypeScript/issues/7837
        // so we get
        // ...<outdir>/main/assets/<code> and
        // ...<outdir>/test/assets/<code> because they have ./src in common
        // we need to find out what their relative paths are wrt the path they have in common
        const common = commonPath(sbtOpts.assetsDirs[0], sbtOpts.assetsDirs[1])
        const relPathAssets = sbtOpts.assetsDirs[0].substring(common.length)
        const relPathTestAssets = sbtOpts.assetsDirs[1].substring(common.length)

        const sourcePath = path.join(target,relPathTestAssets)
        const moveMsg = `${sourcePath} to ${target}`
        // and move the desired emitted test files up to the target path
        //logger.debug("will remove",target+"/"+relPathAssets)
        //logger.debug(`will move contents of ${moveMsg}`)
        // fs.remove(target + "/" + relPathAssets, (e: any) => logger.debug("removed", target + "/" + relPathAssets))
        // fs.copy(sourcePath, target, (e: any) => {
        //     logger.debug(`moved contents of ${moveMsg} ${e}`)
        //     fs.remove(target + "/" + relPathTestAssets, (e: any) => true)
        // })
        return Promise.all([remove(path.join(target,relPathAssets)),move(sourcePath,target)])
    }

    function remove(dir:string):Promise<any>{
        return new Promise((resolve,reject)=>{
            fs.remove(dir, (e:any)=>{
                if(e){
                    reject(e)
                }
                else {
                    logger.debug("removed", dir)
                    resolve({})
                }
            })
        })
    }

    function move(sourcePath:string,target:string):Promise<any>{
        return new Promise((resolve,reject)=>{
            fs.copy(sourcePath, target, (e: any) => {
                if(e){
                    reject(e)
                }
                else {
                    fs.remove(sourcePath, (e: any) =>{
                        if(e){
                            reject(e)
                        }else{
                            logger.debug(`moved contents of ${sourcePath} to ${target}`)
                            resolve({})
                        }
                    })
                }
            })
        })
    }
    function notExistingFiles(filesDeclared: string[]): Promise<string[]> {
        return Promise.all(filesDeclared.map(exists))
            .then((e: [string, boolean][]) => {
                const r: string[] = e.filter(a => {
                    const [s, exist]=a
                    return !exist
                })
                    .map(a => {
                        const [s, b]=a
                        return s
                    })
                return r

            })
        function exists(file: string): Promise<[string, boolean]> {
            return new Promise<[string, boolean]>((resolve, reject) => {
                fs.access(file, (errAccess: any) => {
                    if (errAccess) {
                        resolve([file, false])
                    } else {
                        fs.stat(file, (err: any, stats: any) => {
                            if (err) {
                                reject(err)
                            }
                            else {
                                resolve([file, stats.isFile()])
                            }
                        })
                    }
                })
            })
        }
    }


    function commonPath(path1: string, path2: string) {
        let commonPath = ""
        for (let i = 0; i < path1.length; i++) {
            if (path1.charAt(i) === path2.charAt(i)) {
                commonPath += path1.charAt(i)
            } else {
                return commonPath
            }
        }
        return commonPath
    }

    function toCompilerOptions(sbtOptions: SbtTypescriptOptions): {options: CompilerOptions, errors: Diagnostic[]} {
        const unparsedCompilerOptions: any = sbtOptions.tsconfig["compilerOptions"]
        // logger.debug("compilerOptions ", unparsedCompilerOptions)
        if (unparsedCompilerOptions.outFile) {
            const outFile = path.join(target, unparsedCompilerOptions.outFile)
            logger.debug("single outFile ", outFile)
            unparsedCompilerOptions.outFile = outFile
        }
        if (sbtOptions.assetsDirs.length == 2) {
            unparsedCompilerOptions.rootDirs = sbtOptions.assetsDirs

        } else if (sbtOptions.assetsDirs.length == 1) {
            // ??! one root dir creates the correct output files, two rootdirs throws away shared directories
            unparsedCompilerOptions.rootDir = sbtOptions.assetsDirs[0]
        } else {
            throw new Error("nr of asset dirs should always be 1 or 2")
        }
        unparsedCompilerOptions.listEmittedFiles = true
        return convertCompilerOptionsFromJson(unparsedCompilerOptions, sbtOptions.tsconfigDir, "tsconfig.json")
    }

    function flatFilesWritten(results: CompilationFileResult[]): string[] {
        const files: string[] = []
        results.forEach(cfr => cfr.result.filesWritten.forEach(fw => files.push(fw)))
        return files
    }

    function isCodeFile(f: SourceFile) {
        return !(isDeclarationFile(f))
    }

    function isDeclarationFile(f: SourceFile) {
        const fileName = f.fileName
        return ".d.ts" === fileName.substring(fileName.length - 5)
    }

    function flatten<T>(xs: Option<T>[]): T[] {
        let result: T[] = []
        xs.forEach(x => {
            if (x.value) result.push(x.value)
        })
        return result
    }
}

function toCompilationResult(sourceMappings: SourceMappings, compilerOptions: CompilerOptions): (sf: SourceFile) => Option<CompilationFileResult> {
    return sourceFile => {
        return sourceMappings.find(sourceFile.fileName).map((sm) => {
            // logger.debug("source file is ",sourceFile.fileName)
            let deps = [sourceFile.fileName].concat(sourceFile.referencedFiles.map(f => f.fileName))

            let outputFile = determineOutFile(sm.toOutputPath(compilerOptions.outDir!, ".js"), compilerOptions)

            let filesWritten = [outputFile]

            if (compilerOptions.declaration) {
                let outputFileDeclaration = sm.toOutputPath(compilerOptions.outDir!, ".d.ts")
                filesWritten.push(outputFileDeclaration)
            }

            if (compilerOptions.sourceMap && !compilerOptions.inlineSourceMap) {
                let outputFileMap = outputFile + ".map"
                filesWritten.push(outputFileMap)
            }

            const result = <CompilationFileResult>{
                source: sourceFile.fileName,
                result: {
                    filesRead: deps,
                    filesWritten: filesWritten
                }
            }
            return result

            function determineOutFile(outFile: string, options: CompilerOptions): string {
                if (options.outFile) {
                    logger.debug("single outFile ", options.outFile)
                    return options.outFile
                } else {
                    return outFile
                }
            }
        })
    }
}

function findPreemitProblems(program: Program, tsIgnoreList?: number[]): Problem[] {
    let diagnostics = getPreEmitDiagnostics(program)

    if (tsIgnoreList) return diagnostics.filter(ignoreDiagnostic(tsIgnoreList)).map(parseDiagnostic)
    else return diagnostics.map(parseDiagnostic)
}

function toProblems(diagnostics: Diagnostic[], tsIgnoreList?: number[]): Problem[] {
    if (tsIgnoreList) return diagnostics.filter(ignoreDiagnostic(tsIgnoreList)).map(parseDiagnostic)
    else return diagnostics.map(parseDiagnostic)
}

function ignoreDiagnostic(tsIgnoreList: number[]): (d: Diagnostic) => boolean {
    return (d: Diagnostic) => tsIgnoreList.indexOf(d.code) === -1
}

function parseDiagnostic(d: Diagnostic): Problem {
    let lineCol = {line: 0, character: 0}
    let fileName = "tsconfig.json"
    let lineText = ""
    if (d.file&&d.start) {
        lineCol = d.file.getLineAndCharacterOfPosition(d.start)

        let lineStart = d.file.getLineStarts()[lineCol.line]
        let lineEnd = d.file.getLineStarts()[lineCol.line + 1]
        lineText = d.file.text.substring(lineStart, lineEnd)
        fileName = d.file.fileName
    }

    let problem = <Problem>{
        lineNumber: lineCol.line + 1,
        characterOffset: lineCol.character,
        message: "TS" + d.code + " " + flattenDiagnosticMessageText(d.messageText, sys.newLine),
        source: fileName,
        severity: toSeverity(d.category),
        lineContent: lineText
    }
    return problem

    function toSeverity(i: DiagnosticCategory): string {
        if (i === 0) {
            return "warn"
        } else if (i === 1) {
            return "error"
        } else if (i === 2) {
            return "info"
        } else {
            return "error"
        }
    }
}
