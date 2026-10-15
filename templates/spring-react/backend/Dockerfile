FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml checkstyle.xml ./
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B -q package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/target/app.jar app.jar
RUN useradd --create-home app
USER app
EXPOSE 8080
CMD ["java", "-jar", "app.jar"]
