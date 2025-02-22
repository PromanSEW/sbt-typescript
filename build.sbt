sbtPlugin := true
organization := "com.github.platypii"
name := "sbt-typescript"
version := "5.2.2-SNAPSHOT"

// Scala needs to match sbt
scalaVersion := "2.12.18"

updateOptions := updateOptions.value.withCachedResolution(true)

scalacOptions ++= Seq(
  "-feature",
  "-encoding", "UTF8",
  "-deprecation",
  "-unchecked",
  "-Xlint",
  "-Ywarn-dead-code",
  "-Ywarn-adapted-args"
)

libraryDependencies ++= Seq(
  // js dependencies
  "org.webjars.npm" % "typescript" % "5.2.2",
  // Used by ...?
  "org.webjars.npm" % "fs-extra" % "10.1.0",
  "org.webjars.npm" % "es6-shim" % "0.35.8",
)

resolvers ++= Seq(
  Resolver.bintrayRepo("webjars", "maven"),
  Resolver.typesafeRepo("releases"),
  Resolver.sbtPluginRepo("releases"),
  Resolver.mavenLocal
)

resolvers ++= Resolver.sonatypeOssRepos("snapshots")

addSbtPlugin("com.github.sbt" % "sbt-js-engine" % "1.3.5-M1")

enablePlugins(SbtPlugin)
scriptedLaunchOpts := Seq(s"-Dproject.version=${version.value}")
scriptedBufferLog := false
