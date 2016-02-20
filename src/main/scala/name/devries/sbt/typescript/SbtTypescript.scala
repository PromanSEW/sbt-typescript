package name.devries.sbt.typescript

import akka.event.Logging.LogLevel
import com.typesafe.sbt.jse.JsEngineImport.JsEngineKeys
import com.typesafe.sbt.jse.SbtJsTask
import com.typesafe.sbt.web.{CompileProblems, LineBasedProblem}
import sbt.Keys._
import sbt._
import spray.json._
import xsbti.Severity
import com.typesafe.sbt.jse.SbtJsEngine.autoImport.JsEngineKeys._
import com.typesafe.sbt.jse.SbtJsTask.autoImport.JsTaskKeys._
import com.typesafe.sbt.web.Import.WebKeys._
import com.typesafe.sbt.web.SbtWeb.autoImport._

import scala.collection.mutable
import scala.collection.mutable.ListBuffer

object SbtTypescript extends AutoPlugin with JsonProtocol {

  override def requires = SbtJsTask

  override def trigger = AllRequirements

  object autoImport {
    val typescript = TaskKey[Seq[File]]("typescript", "Run Typescript compiler")

    val projectFile = SettingKey[File]("typescript-projectfile",
      "The location of the tsconfig.json  Default: <basedir>/tsconfig.json")
    val getTsConfig = TaskKey[JsObject]("get-tsconfig", "parses the tsconfig.json file")

    val tsCodesToIgnore = SettingKey[List[Int]]("typescript-codes-to-ignore",
      "The tsc error codes (f.i. TS2307) to ignore. Default none")

    val canNotFindModule = 2307 //see f.i. https://github.com/Microsoft/TypeScript/issues/3808
  }

  import autoImport._

  // wrt to out vs outFile see https://github.com/Microsoft/TypeScript/issues/5107
  val typescriptUnscopedSettings = Seq(
    logLevel := Level.Debug,
    includeFilter := GlobFilter("*.ts") | GlobFilter("*.tsx"),
    excludeFilter := GlobFilter("*.d.ts"),
    jsOptions := JsObject(Map(
      "logLevel" -> JsString(logLevel.value.toString),
      "tsconfig" ->parseTsConfig().value ,
      "tsconfigDir" -> JsString(projectFile.value.getParent),
      "assetsDir" -> JsString((sourceDirectory in Assets).value.getAbsolutePath),
      "tsCodesToIgnore" -> JsArray(tsCodesToIgnore.value.toVector.map(JsNumber(_)))
    )).toString()
  )

  override def projectSettings = Seq(
    tsCodesToIgnore := List.empty[Int],
    projectFile := baseDirectory.value / "tsconfig.json",
    JsEngineKeys.parallelism := 1
  ) ++inTask(typescript)(
    SbtJsTask.jsTaskSpecificUnscopedSettings ++
      inConfig(Assets)(typescriptUnscopedSettings) ++
      inConfig(TestAssets)(typescriptUnscopedSettings) ++
      Seq(
        moduleName := "typescript",
        shellFile := getClass.getClassLoader.getResource("typescript.js"),

        taskMessage in Assets := "Typescript compiling",
        taskMessage in TestAssets := "Typescript test compiling"
      )
  ) ++ SbtJsTask.addJsSourceFileTasks(typescript) ++ Seq(
    typescript in Assets := (typescript in Assets).dependsOn(webModules in Assets).value,
    typescript in TestAssets := (typescript in TestAssets).dependsOn(webModules in TestAssets).value
  )


  def parseTsConfig() = Def.task {
    val tsConfigFile = projectFile.value

    val content = IO.read(tsConfigFile)

    JsonParser(removeComments(content))
  }

  def removeComments(string: String)={
    // cribbed from http://blog.ostermiller.org/find-comment
    string.replaceAll("""/\*([^*]|[\r\n]|(\*+([^*/]|[\r\n])))*\*+/""","")
  }

}